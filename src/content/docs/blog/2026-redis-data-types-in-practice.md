---
title: Redis data types in practice — stop storing everything as a JSON string
date: 2026-11-23
authors: rene
tags: [caching, dotnet, performance]
excerpt: Most .NET codebases use Redis as a big dictionary of serialized JSON. That works until you need to change one field, count something or answer "is X in Y?". A practical tour of strings, lists, sets, sorted sets and hashes with StackExchange.Redis, and when to use which.
---

:::note[Series]
Part of the series [*Caching & data*](/series/caching-and-data/).
:::

Open almost any .NET codebase that uses Redis and you'll find the same thing: an `ICache` with
`GetAsync<T>` and `SetAsync<T>`, and underneath it a `JsonSerializer.Serialize` followed by
`StringSetAsync`. Redis is used as a remote `Dictionary<string, string>`.

That's not wrong. For a lot of cache entries it's exactly the right choice. But Redis is a **data
structure server**, not a key-value store, and if strings are the only type you ever use, you end up
doing things in C# that Redis could do for you: reading a 40 KB blob to change one flag, loading a
list of 5,000 IDs to check whether one of them is in it, or building leaderboards with `OrderBy` in
memory.

One team I worked with put it into their guidelines in one sentence: *don't just serialize an
object and store it, use the native data types where it makes sense.* This post is the practical
version of that sentence.

## The setup

All examples use [StackExchange.Redis](https://stackexchange.github.io/StackExchange.Redis/). The
one rule that matters before anything else: **one `ConnectionMultiplexer` per application**, shared
as a singleton. It's thread-safe, it multiplexes all commands over one connection, and creating one
per request is the Redis version of `new HttpClient()` per request.

```csharp
builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!));

builder.Services.AddScoped(sp =>
    sp.GetRequiredService<IConnectionMultiplexer>().GetDatabase());   // IDatabase is a cheap facade
```

## The "before": one JSON blob per customer

```csharp
public sealed class CustomerCache(IDatabase redis)
{
    public async Task MarkNewsletterConsentAsync(int customerId, bool consent)
    {
        var key = $"shop:customer:{customerId}";

        var json = await redis.StringGetAsync(key);                    // read everything
        var customer = JsonSerializer.Deserialize<CachedCustomer>(json!)!;

        customer = customer with { NewsletterConsent = consent };      // change one field

        await redis.StringSetAsync(key, JsonSerializer.Serialize(customer));   // write everything
    }
}
```

Three problems hide in these few lines:

1. **Bandwidth and CPU.** You transfer and (de)serialize the whole object to change one boolean.
2. **Lost updates.** Two requests that change different fields at the same time both read the old
   version, and the second write silently overwrites the first one.
3. **The TTL is gone.** `StringSetAsync` without an expiry removes the existing TTL. The entry that
   was supposed to live ten minutes now lives forever. (Since StackExchange.Redis 2.x you can pass
   `keepTtl: true`, but you have to know it.)

The same entity as a **hash** fixes all three at once:

```csharp
await redis.HashSetAsync("shop:customer:42", "newsletterConsent", true);   // atomic, one field, TTL untouched
```

That's the whole point of the native types: **Redis does the operation on the server, atomically,
on exactly the part of the data you care about.**

## Strings: the simple key-value pair

Strings are the default and the most flexible type. Despite the name, a string is just a binary-safe
value up to 512 MB (please don't go anywhere near that), and Redis can treat it as a number.

```csharp
// Plain value with TTL
await redis.StringSetAsync("shop:product:1337:summary", json, expiry: TimeSpan.FromMinutes(10));

// Counters are atomic on the server — no read-modify-write in C#
long views = await redis.StringIncrementAsync("shop:product:1337:views");

// Several keys in one round trip (MGET)
RedisKey[] keys = ["shop:product:1:summary", "shop:product:2:summary", "shop:product:3:summary"];
RedisValue[] values = await redis.StringGetAsync(keys);

// Only set if it doesn't exist yet (SET ... NX), e.g. for a simple lock or idempotency key
bool acquired = await redis.StringSetAsync(
    "shop:order:9001:processing", Environment.MachineName,
    expiry: TimeSpan.FromSeconds(30), when: When.NotExists);
```

**Use strings for:** serialized responses you always read and write as a whole (the typical
"cache this API result" case), counters, flags, idempotency keys, simple locks.

**Don't use them for:** objects where you regularly read or update single properties, and anything
that is really a collection.

## Lists: ordered, duplicates allowed, think "queue"

A Redis list is a **linked list**, not an array. Pushing and popping at both ends is O(1); accessing
an element in the middle is O(n). Lists keep insertion order and allow duplicates.

```csharp
// "Recently viewed products": push to the head, keep only the last 20
await redis.ListLeftPushAsync("shop:customer:42:recently-viewed", "product:1337");
await redis.ListTrimAsync("shop:customer:42:recently-viewed", 0, 19);

RedisValue[] recent = await redis.ListRangeAsync("shop:customer:42:recently-viewed", 0, 9);

// A simple work queue: producer pushes left, consumer pops right
await redis.ListLeftPushAsync("shop:queue:invoice-pdf", invoiceId);
RedisValue next = await redis.ListRightPopAsync("shop:queue:invoice-pdf");
```

**Use lists for:** queues, stacks, capped "last N" histories, activity feeds.

**Don't use them for:** relationships between entities. "Which products are in category 7?" is a
membership question, and `LRANGE 0 -1` plus a `Contains` in C# is the slow way to answer it. For
real work queues with acknowledgements and consumer groups, look at **Streams** or a proper message
broker instead.

## Sets: unordered, unique, think "membership"

A set is an unordered collection of unique strings. Membership checks are O(1), and Redis can compute
unions, intersections and differences on the server.

Sets are the natural way to store **relationships**. And because a set only answers the question
from one direction, a relationship you need to read both ways becomes **two sets**:

```csharp
// Which categories is a product in? Which products are in a category?
await redis.SetAddAsync("shop:product:1337:categories", [7, 12]);
await redis.SetAddAsync("shop:category:7:products", 1337);
await redis.SetAddAsync("shop:category:12:products", 1337);

// O(1) membership check — no need to load the whole set
bool inSale = await redis.SetContainsAsync("shop:category:12:products", 1337);

// Products that are both "on sale" (12) and "outdoor" (7), computed in Redis
RedisValue[] both = await redis.SetCombineAsync(
    SetOperation.Intersect, "shop:category:12:products", "shop:category:7:products");

long count = await redis.SetLengthAsync("shop:category:7:products");   // SCARD
```

Keeping both directions in sync is your job. Write them in a transaction (`CreateTransaction()`) so
you never end up with one side updated and the other not.

**Use sets for:** relationships, tags, "has this user already voted / seen / received X",
permission lookups like "is user 42 a member of tenant 9", and as **secondary indexes** of other keys
(more on that in the [key conventions](/blog/2026-redis-key-conventions/) post).

**Don't use them for:** anything where order matters, or where you need a value per member.

## Sorted sets: unique members with a score

A sorted set is a set where every member has a floating-point **score**, and Redis keeps the members
ordered by that score at all times. Members with the same score are ordered lexicographically. Range
queries by rank or by score are O(log n).

```csharp
// Best-selling products: increment the score atomically on every sale
await redis.SortedSetIncrementAsync("shop:bestsellers:2026-11", "product:1337", quantity);

// Top 10, highest first, with scores
SortedSetEntry[] top = await redis.SortedSetRangeByRankWithScoresAsync(
    "shop:bestsellers:2026-11", 0, 9, Order.Descending);

// Time-based index: score = Unix timestamp
await redis.SortedSetAddAsync("shop:orders:pending", orderId, DateTimeOffset.UtcNow.ToUnixTimeSeconds());

// All orders pending for more than 30 minutes
var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30).ToUnixTimeSeconds();
RedisValue[] stale = await redis.SortedSetRangeByScoreAsync("shop:orders:pending", stop: cutoff);
```

**Use sorted sets for:** leaderboards and rankings, time-based indexes ("everything older than X"),
sliding-window rate limiting, priority queues, and relationships that have an order (the products of
a customer's wish list in the order they were added).

**Don't use them for:** plain membership without an order. A set is cheaper.

## Hashes: one object, many fields

A hash is a map of field-value pairs inside one key. It is exactly **one level deep**: you can't
nest a hash in a hash.

```csharp
await redis.HashSetAsync("shop:customer:42",
[
    new HashEntry("name", "Ada Example"),
    new HashEntry("tier", "gold"),
    new HashEntry("newsletterConsent", true),
    new HashEntry("loyaltyPoints", 1200),
]);

RedisValue tier = await redis.HashGetAsync("shop:customer:42", "tier");          // one field
RedisValue[] some = await redis.HashGetAsync("shop:customer:42", ["name", "tier"]);
HashEntry[] all = await redis.HashGetAllAsync("shop:customer:42");

await redis.HashIncrementAsync("shop:customer:42", "loyaltyPoints", 50);          // atomic
```

Mapping between a record and a hash is a few lines and keeps your domain types clean:

```csharp
public sealed record CachedCustomer(string Name, string Tier, bool NewsletterConsent, long LoyaltyPoints)
{
    public HashEntry[] ToHashEntries() =>
    [
        new(nameof(Name), Name),
        new(nameof(Tier), Tier),
        new(nameof(NewsletterConsent), NewsletterConsent),
        new(nameof(LoyaltyPoints), LoyaltyPoints),
    ];

    public static CachedCustomer? FromHashEntries(HashEntry[] entries)
    {
        if (entries.Length == 0) return null;
        var d = entries.ToDictionary(e => e.Name.ToString(), e => e.Value);
        return new CachedCustomer(d[nameof(Name)].ToString(), d[nameof(Tier)].ToString(),
                                  (bool)d[nameof(NewsletterConsent)], (long)d[nameof(LoyaltyPoints)]);
    }
}
```

Hashes are also a good container for **paged or parameterised results that belong together**: put
all cached pages of "products in category 7" as fields into one hash, and invalidating the whole
thing is a single `DEL` on one key instead of a pattern search.

**Use hashes for:** entities where you read or update individual properties, groups of related
cache entries you want to invalidate together, small per-entity counters.

**Don't use them for:** lists of things, or deeply nested data. For deep JSON that the front end
consumes as a whole, a string is still the better fit.

:::tip[What about JSON and Streams?]
Redis Stack and Redis 8 ship a native **JSON** type (`JSON.SET`, `JSON.GET` with JSONPath), which
lets you update nested fields in place. In .NET you use it through
[NRedisStack](https://github.com/redis/NRedisStack). It's worth it if you really need partial updates
of nested documents. Check first whether your managed Redis offering supports it. **Streams** are an
append-only log with consumer groups, for event-style workloads where a list isn't enough.
:::

## When to use which

| Question you want Redis to answer | Type | Typical commands |
|---|---|---|
| "Give me this whole thing" | String | `GET`, `SET`, `MGET` |
| "Count this" | String (integer) | `INCR`, `INCRBY` |
| "What were the last N?" / "What's next in line?" | List | `LPUSH`, `LTRIM`, `RPOP` |
| "Is X in Y?" / "What do A and B have in common?" | Set | `SISMEMBER`, `SINTER`, `SUNION` |
| "Top N by something" / "Everything older than T" | Sorted set | `ZINCRBY`, `ZRANGE`, `ZRANGEBYSCORE` |
| "Give me / change one property of this object" | Hash | `HGET`, `HSET`, `HINCRBY` |
| "Change a nested field of a document" | JSON (Redis Stack / 8) | `JSON.SET`, `JSON.GET` |

## Pitfalls

**TTL is per key, not per element.** You can't expire a single set member or list item. (Redis 7.4+
does support TTLs on individual hash fields via `HEXPIRE`.) If elements need individual lifetimes,
use a sorted set with a timestamp score and remove old ones with `ZREMRANGEBYSCORE`.

**Writing a whole value removes the TTL.** A plain `SET` replaces the key, including its expiry. Pass
the expiry again or use `keepTtl: true`.

**Big keys.** A set with two million members or a 20 MB string is a problem no matter the type:
reading it blocks Redis for everyone (it's single-threaded for command execution), and it moves a
lot of data over the network. Read large collections incrementally with `SSCAN`, `HSCAN` or
`ZSCAN` (StackExchange.Redis does that for you with `SetScanAsync` and friends, which return an
`IAsyncEnumerable`).

**`KEYS *` in production.** Never. It scans the entire keyspace and blocks the server. Use
`SCAN`, or better, keep a set as an index of the keys you'll need to find again.

**Relationships in only one direction.** If you store "categories of a product" but later need
"products of a category", you'll be scanning. Decide up front which directions you read, and store
each one.

**Non-atomic multi-step updates.** Updating two sets in two separate calls can leave them out of
sync on failure. Use `CreateTransaction()` (MULTI/EXEC) or a Lua script for things that must happen
together, and `CreateBatch()` when you only want to save round trips.

## How to check what you've got

- **Find big keys:** `redis-cli --bigkeys` (or `--memkeys`) samples the keyspace and reports the
  largest key per type. `MEMORY USAGE <key>` tells you the size of one key.
- **Check the internal encoding:** `OBJECT ENCODING shop:customer:42`. Small hashes, sets and sorted
  sets use a compact `listpack` encoding, which is very memory efficient. If yours all say
  `hashtable` or `skiplist`, they've outgrown it.
- **Find slow commands:** `SLOWLOG GET 20` shows the commands that took longest on the server. A
  `SMEMBERS` or `HGETALL` near the top means a collection has grown too big to read in one go.
- **Test against the real thing:** Spin up Redis in integration tests with
  [Testcontainers](https://dotnet.testcontainers.org/modules/redis/) instead of mocking `IDatabase`.
  Mocks happily accept a TTL that the real command would discard.

## Summary

- Redis is a **data structure server**. Using only strings turns it into a slow remote dictionary.
- **Strings** for whole values and counters, **lists** for queues and "last N", **sets** for
  membership and relationships, **sorted sets** for rankings and time-based indexes, **hashes** for
  objects whose fields you read or change individually.
- Native types let Redis do the work **atomically on the server** and avoid read-modify-write
  races and wasted bandwidth.
- Store relationships you read in both directions as **two sets**, and update them together.
- Watch out for **TTL per key**, **big keys** and **`KEYS *`**, and check with `--bigkeys`,
  `OBJECT ENCODING` and `SLOWLOG`.
