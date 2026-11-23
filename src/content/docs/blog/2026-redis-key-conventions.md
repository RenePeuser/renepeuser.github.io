---
title: Redis key conventions — naming, hierarchy and invalidation that scales
date: 2026-11-23
authors: rene
tags: [caching, code-quality, dotnet]
excerpt: A Redis key is the only schema Redis has. Hierarchical names, deterministic parameter hashing, secondary index sets and generation counters make keys readable, collision-free and cheap to invalidate, without ever calling KEYS in production.
---

:::note[Series]
Part of the series [*Caching & data*](/series/caching-and-data/).
:::

Redis has no tables, no columns and no schema. The **key is the schema**. Whatever ends up in the
key is everything you'll ever have to find, group, debug and invalidate an entry. And because every
developer builds keys with string interpolation, a Redis instance that's a few years old usually
contains a museum of styles:

```text
9/Dashboard/Resource
customer_42
Customer:42
GetProductsAsync-8F3A1C...E9
shop:customer:42:orders
```

Each of them made sense to whoever wrote it. Together they make it impossible to answer simple
questions like "which keys belong to tenant 9?" or "what do I have to delete when product 1337
changes?".

This post is the set of conventions I use, most of them taken from a key-naming guideline a team I
worked with had written down after exactly that museum had grown for a while.

## Rule 1: keys are hierarchical, from broad to narrow

A key is a path of `name:id` pairs, separated by colons, ordered from the broadest scope to the
narrowest:

```text
<app>:<scope>:<id>:<entity>:<id>[:<sub-resource>][:<params>]

shop:customer:42
shop:customer:42:orders
shop:tenant:9:product:1337
shop:tenant:9:product:1337:translation:en
shop:tenant:9:products:search:v2:5d41402abc4b2a76
```

Why this order matters:

- **Readability.** `shop:tenant:9:product:1337` reads like a URL. `9/Dashboard/Resource` reads like a
  puzzle: is 9 a tenant, a project, a page?
- **Tooling.** RedisInsight and most other GUIs render the colon as a tree, so you can browse a tenant's
  keys like a folder.
- **Scans when you really need them.** `SCAN 0 MATCH shop:tenant:9:*` finds everything for a tenant,
  because the tenant comes first. If the tenant is in the middle or at the end, no pattern helps you.

The colon is a convention, not a feature. Redis doesn't care. Your team and your tools do.

## Rule 2: pick one casing and stick to it

Keys are **binary-safe and case-sensitive**. `shop:Customer:42` and `shop:customer:42` are two
different keys, which means two cache entries, one of which is never invalidated.

It doesn't really matter whether you choose lowercase (`shop:customer:42`) or PascalCase
(`Shop:Customer:42`). The guideline I mentioned used PascalCase to match their database naming. I
prefer lowercase with hyphens inside a segment (`recently-viewed`), because it matches URLs. What
matters is that there's **one rule** and a piece of code that enforces it (see rule 6).

## Rule 3: plurals for collections, two keys for two directions

If a key holds **one thing**, use the singular. If it holds a **collection** (list, set, sorted
set), use the plural:

```text
shop:customer:42                  → hash: one customer
shop:customer:42:orders           → set: the order IDs of customer 42
shop:category:7:products          → set: the product IDs in category 7
shop:product:1337:categories      → set: the category IDs of product 1337
```

Note the last two lines. A relationship you read from both sides is stored **twice**, once per
direction, as described in the [Redis data types](/blog/2026-redis-data-types-in-practice/) post. The
key name tells you which direction you're looking at.

## Rule 4: everything that changes the result belongs in the key

This one causes the nastiest bugs, because they look like data leaks or random staleness.

A cache key must contain **every input that influences the cached value**:

- the **tenant**, always, in a multi-tenant system
- the **user or role**, if the result depends on permissions. If two users can see different
  subsets of "all products", their results must not share a key.
- the **language**, if the content is translated
- **paging, sorting, filters** for list results
- a **version** segment, if the shape of the cached object changes between deployments

In one codebase I worked on, paged role lists were cached per project in a hash, with the **user ID
in the key**, precisely because some users could only see their own roles. Leave the user out and the
first person to load the page decides what everybody else sees.

## Rule 5: parameters get normalized, then hashed

For query-like results with many parameters, you can't (and shouldn't) spell out every parameter in
the key. Hash them, but **normalize first**, so that semantically identical requests produce the same
key:

```csharp
public static class CacheKeyHash
{
    public static string For(params ReadOnlySpan<object?> parts)
    {
        var normalized = string.Join('|', parts.ToArray().Select(Normalize));
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexStringLower(hash.AsSpan(0, 8));   // 16 hex chars is plenty for a cache key
    }

    private static string Normalize(object? value) => value switch
    {
        null => "∅",
        string s => s.Trim().ToLowerInvariant(),
        IEnumerable<int> ids => string.Join(',', ids.Order()),         // order must not change the key
        IEnumerable<long> ids => string.Join(',', ids.Order()),
        IEnumerable<string> items => string.Join(',', items.Order(StringComparer.Ordinal)),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? ""
    };
}
```

The `Order()` calls matter more than they look. A team I worked with found that a list of excluded IDs
in a different order produced a different key for the same result. Sorting the lists before
building the key fixed it.

Keep a **readable prefix** in front of the hash. `GetProductsAsync-8F3A1C...` tells you which method
wrote it, but not which tenant it belongs to, so you can never find or delete it selectively.
`shop:tenant:9:products:search:v2:5d41402abc4b2a76` tells you everything except the parameters,
and that's fine.

## Rule 6: keys are built in one place, never with ad-hoc interpolation

Conventions written in a wiki erode. Put them in code:

```csharp
public static class ShopKeys
{
    private const string App = "shop";

    public static RedisKey Customer(int customerId)        => $"{App}:customer:{customerId}";
    public static RedisKey CustomerOrders(int customerId)  => $"{App}:customer:{customerId}:orders";
    public static RedisKey Product(int tenantId, int id)   => $"{App}:tenant:{tenantId}:product:{id}";

    public static RedisKey ProductSearch(int tenantId, ProductSearch query) =>
        $"{App}:tenant:{tenantId}:products:search:v2:" +
        CacheKeyHash.For(query.Text, query.CategoryIds, query.SortBy, query.Page, query.PageSize);

    // Index sets, see below
    public static RedisKey TenantIndex(int tenantId)              => $"{App}:tenant:{tenantId}:cache-keys";
    public static RedisKey ProductIndex(int tenantId, int id)     => $"{App}:tenant:{tenantId}:product:{id}:cache-keys";
}
```

If several services share one Redis instance, StackExchange.Redis can enforce the app prefix for you:

```csharp
// using StackExchange.Redis.KeyspaceIsolation;
IDatabase db = multiplexer.GetDatabase().WithKeyPrefix("shop:");
```

Every key written through `db` is prefixed automatically, so one service can't accidentally overwrite
another one's keys.

## Invalidation: don't search, index

Sooner or later someone needs "delete everything for tenant 9" or "delete everything that depends on
product 1337". The tempting answer is a pattern:

```csharp
// Don't. KEYS blocks the server while it walks the entire keyspace.
var keys = server.Keys(pattern: "shop:tenant:9:*");
```

`IServer.Keys` uses `SCAN` under the hood when the server supports it, so it doesn't block Redis the
way `KEYS` does. It still **walks the whole keyspace** to find a handful of keys. With millions of
entries that's slow, and on a cluster you have to do it on every primary node.

There are two better options.

### Option A: secondary index sets

Every time you write a cache entry, you also add its key to one or more **index sets**, one per scope
you'll want to invalidate. The guideline I keep referring to used three: per project, per project and
module, per project and resource.

```csharp
public sealed class IndexedCache(IDatabase redis)
{
    public async Task SetAsync(RedisKey key, RedisValue value, TimeSpan ttl, params RedisKey[] indexes)
    {
        var tran = redis.CreateTransaction();

        _ = tran.StringSetAsync(key, value, ttl);
        foreach (var index in indexes)
        {
            _ = tran.SetAddAsync(index, key.ToString());
            _ = tran.KeyExpireAsync(index, ttl + TimeSpan.FromMinutes(5));   // index outlives its entries
        }

        await tran.ExecuteAsync();
    }

    public async Task InvalidateAsync(RedisKey index)
    {
        await foreach (var batch in ReadInBatchesAsync(index, 500))
            await redis.KeyDeleteAsync(batch);

        await redis.KeyDeleteAsync(index);
    }

    private async IAsyncEnumerable<RedisKey[]> ReadInBatchesAsync(RedisKey index, int size)
    {
        var batch = new List<RedisKey>(size);
        await foreach (var member in redis.SetScanAsync(index, pageSize: size))
        {
            batch.Add(member.ToString());
            if (batch.Count == size) { yield return [.. batch]; batch.Clear(); }
        }
        if (batch.Count > 0) yield return [.. batch];
    }
}
```

```csharp
await cache.SetAsync(ShopKeys.ProductSearch(9, query), json, TimeSpan.FromMinutes(10),
                     ShopKeys.TenantIndex(9), ShopKeys.ProductIndex(9, 1337));

// Product 1337 changed:
await cache.InvalidateAsync(ShopKeys.ProductIndex(9, 1337));
```

Invalidation is now proportional to the number of affected keys, not to the size of the instance.

### Option B: generation counters

If you only ever invalidate **whole scopes** ("everything for tenant 9"), you don't need to delete
anything at all. Keep a counter per scope and put it into the key:

```csharp
var gen = (long?)await redis.StringGetAsync("shop:tenant:9:gen") ?? 0;
RedisKey key = $"shop:tenant:9:g{gen}:products:search:v2:{hash}";

// Invalidate tenant 9: all old keys become unreachable and expire through their TTL
await redis.StringIncrementAsync("shop:tenant:9:gen");
```

Invalidation is a single `INCR`. The price is one extra read per lookup (cache the generation locally
for a second or two if that matters) and memory held by orphaned entries until their TTL runs out. So
this only works if **every entry has a TTL**.

| | Pattern scan | Index sets | Generation counter |
|---|---|---|---|
| Cost of invalidation | Whole keyspace | Number of affected keys | One `INCR` |
| Cost per write | None | One `SADD` per index | None |
| Cost per read | None | None | One extra `GET` (cacheable) |
| Fine-grained ("only product 1337") | ✅ if the key layout allows it | ✅ | ❌ scopes only |
| Memory freed immediately | ✅ | ✅ | ❌ waits for TTL |
| Safe on a large production instance | ❌ | ✅ | ✅ |

## Pitfalls

**Curly braces in keys on Redis Cluster.** Documentation likes to write keys as
`shop:customer:{id}`. In code, make sure the braces don't end up in the actual key. In Redis
Cluster, `{...}` is a **hash tag**: only the part inside the braces is used to pick the slot. Used
deliberately (`shop:{tenant:9}:...`), that's how you keep all keys of one tenant on the same node so
that `MGET`, transactions and `SINTER` across them work. Used accidentally, it puts all your keys on
one node.

**Stale index entries.** Keys in an index set can expire on their own, while their names stay in
the set. That's harmless for invalidation (`DEL` on a missing key is a no-op), but give the index a
TTL too, or it grows forever.

**Race between write and invalidation.** A request that reads from the database, then gets slow,
then writes to the cache *after* an invalidation, writes stale data back. Short TTLs limit the
damage. For critical data, store a version or timestamp with the value and refuse to overwrite a
newer one.

**Huge key names.** Key names count against memory too. Readable, yes. A 300-character key for
each of ten million entries, no. Hash the long tail.

## Make it enforceable

- **A test over the key builder.** Call every method of `ShopKeys` with sample values and assert that
  the result matches `^shop(:[a-z0-9-]+)+$`. Anyone who adds a key with uppercase letters, spaces or
  braces breaks the build.
- **Ban the raw API outside the cache layer.** An architecture test (for example with
  [NetArchTest](https://github.com/BenMorris/NetArchTest)) can make sure only the caching namespace
  depends on `StackExchange.Redis`. Then all keys have to go through `ShopKeys`. That's the idea
  behind [self-defending codebases](/blog/2026-self-defending-codebases/).
- **Look at what's actually there.** `redis-cli --scan --pattern 'shop:*' | cut -d: -f1-3 | sort | uniq -c`
  on a staging copy gives you a quick histogram of your key namespaces. Anything that doesn't start
  with your prefix is someone's private convention.

## Summary

- The key is Redis' only schema. Make it **hierarchical**, from broad to narrow: app, tenant,
  entity and ID, sub-resource, parameters.
- **One casing**, **plurals for collections**, and **one key per direction** for relationships.
- Put **every input that changes the result** into the key: tenant, user or role, language,
  paging, version.
- **Normalize parameters before hashing**, and keep a readable prefix in front of the hash.
- Build keys in **one place in code**, and invalidate with **index sets** or **generation
  counters** instead of pattern scans.
