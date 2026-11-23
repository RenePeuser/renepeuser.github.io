---
title: Immutable collections and serialization — what really round-trips
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, csharp, pitfalls]
excerpt: System.Text.Json supports immutable collections, until it suddenly says it doesn't. The default ImmutableArray that crashes, the object values that come back as JsonElement, the frozen collections nobody tested, and how to choose read-only types for your contracts.
---

:::note[Series]
Part of the series [*.NET pitfalls*](/series/dotnet-pitfalls/).
:::

I like immutable data. Records, `init` properties and immutable collections remove a whole category of
bugs: nobody changes a list you handed out, and a snapshot stays a snapshot. They also cross a boundary
all the time: HTTP responses, messages, cache entries. That's where the surprises are.

One of them I saw in a codebase right after a framework upgrade. The API suddenly answered with `500`,
and the log said:

```
System.NotSupportedException: The type
'System.Collections.Immutable.IImmutableDictionary`2[System.String,System.Object]'
is not supported. Path: $.ErrorDetails
```

`System.Text.Json` has supported the immutable collection interfaces since .NET 5, so the message was
misleading. The fix turned out not to be in the code at all, but in the container setup: the image ran
with the wrong working directory and picked up mismatched assemblies. Once the deployment was correct,
the same type serialized fine.

The lesson isn't "immutable collections don't serialize". It's that serialization of collection types
has more edge cases than people expect, and when it fails, the message doesn't always point to the cause.
Here are the ones worth knowing.

## What System.Text.Json supports

The good news first. `System.Text.Json` serializes **and** deserializes:

- `ImmutableArray<T>`, `ImmutableList<T>`, `ImmutableHashSet<T>`, `ImmutableSortedSet<T>`,
  `ImmutableQueue<T>`, `ImmutableStack<T>`
- `ImmutableDictionary<TKey, TValue>`, `ImmutableSortedDictionary<TKey, TValue>`
- the interfaces `IImmutableList<T>`, `IImmutableSet<T>`, `IImmutableDictionary<TKey, TValue>` and friends
- `IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IReadOnlyDictionary<TKey, TValue>`

On deserialization, it collects the items into a temporary buffer and then calls the matching
`CreateRange`. The JSON looks exactly like a normal array or object. So this round-trips:

```csharp
public sealed record OrderSnapshot(
    OrderId Id,
    ImmutableArray<OrderLine> Lines,
    ImmutableDictionary<string, string> Tags);

var json = JsonSerializer.Serialize(snapshot);
var copy = JsonSerializer.Deserialize<OrderSnapshot>(json);
```

The source generator (`JsonSerializerContext`) handles these types as well, which matters if you use
Native AOT or trimming.

## Pitfall 1: the default ImmutableArray

`ImmutableArray<T>` is a struct wrapping an array. Its `default` value wraps `null`:

```csharp
public sealed class OrderSummary
{
    public ImmutableArray<OrderLine> Lines { get; init; }   // default(ImmutableArray<OrderLine>)
}

var summary = new OrderSummary();       // nobody set Lines
summary.Lines.Length;                   // ❌ NullReferenceException
JsonSerializer.Serialize(summary);      // ❌ fails as well
```

`IsDefault` is `true`, and almost every operation throws. It's easy to get there: an object initializer
that forgets the property, a mapper that skips it, or a JSON payload without the `lines` property.

Ways out:

- Initialize it: `public ImmutableArray<OrderLine> Lines { get; init; } = [];` (collection expressions
  work with immutable collections since C# 12).
- Make it `required`, or a primary constructor parameter, so it can't be forgotten.
- At boundaries where data may be missing, normalize: `Lines.IsDefault ? [] : Lines`.

## Pitfall 2: object values come back as JsonElement

The type from the error message above, `IImmutableDictionary<string, object>`, has a second trap that
has nothing to do with deployment:

```csharp
var details = ImmutableDictionary<string, object>.Empty
    .Add("orderId", 4711)
    .Add("retryable", true);

var json = JsonSerializer.Serialize(details);                        // {"orderId":4711,"retryable":true}
var back = JsonSerializer.Deserialize<ImmutableDictionary<string, object>>(json)!;

back["orderId"] is int;          // false
back["orderId"].GetType();       // System.Text.Json.JsonElement
```

JSON doesn't carry .NET types, so `System.Text.Json` can't know that `4711` was an `int`. Values typed as
`object` deserialize as `JsonElement`. Code that does `(int)details["orderId"]` works in-process and
throws after a round trip through a cache or a queue.

Prefer typed contracts. If you really need a bag of values (problem details extensions, for example),
type it as `IReadOnlyDictionary<string, JsonElement>` or `JsonObject` on the reading side, so nobody
pretends the original types survived.

## Pitfall 3: the types nobody tested

Not every read-only collection type in the BCL is equally supported, and support differs between
serializers and versions:

- **Frozen collections** (`FrozenDictionary<TKey, TValue>`, `FrozenSet<T>`, .NET 8+) are built for fast
  reads of data that never changes. They're perfect inside a process. Whether your serializer can
  *create* them on deserialization depends on the serializer and its version, so don't assume it.
- **`ReadOnlyCollection<T>`** and custom collection classes without a public parameterless constructor
  and `Add` method often can't be deserialized without a converter.
- **Other serializers** (Newtonsoft.Json, MessagePack, protobuf-net, XML) each have their own rules for
  immutable types.

The reliable answer is a round-trip test for every type that crosses a boundary (see below), not a
compatibility table from a blog post, including this one.

## Pitfall 4: choosing the wrong immutable type

`ImmutableList<T>` sounds like the obvious immutable `List<T>`. It isn't the obvious choice for DTOs. It's
implemented as a balanced tree so that `Add` and `Remove` can return a new list cheaply by sharing
structure. The price is more memory per item and an O(log n) indexer.

| Type | Good for | Not good for |
|---|---|---|
| `ImmutableArray<T>` | Snapshots, DTOs, read-heavy data; array-speed reads | Frequent "modifications" (every change copies the whole array); beware `default` |
| `ImmutableList<T>` | Data that's repeatedly modified functionally (`Add`, `SetItem`) | Large read-only payloads, hot indexing loops |
| `IReadOnlyList<T>` (backed by an array or list) | Public contracts; cheapest option | Guarantees: the caller could cast it back to `List<T>` |
| `FrozenDictionary` / `FrozenSet` | Lookup tables built once at startup, read millions of times | Wire contracts (test before you rely on it) |

For HTTP and message contracts, my default is `IReadOnlyList<T>` in the contract type and an array behind
it. Immutable types are great inside the domain and in caches. On the wire, JSON is JSON anyway: the
receiver decides what to deserialize into.

If you build immutable collections in a loop, use the builder instead of creating a new collection per
item:

```csharp
var builder = ImmutableArray.CreateBuilder<OrderLine>(initialCapacity: rows.Count);
foreach (var row in rows)
    builder.Add(OrderLine.From(row));

var lines = builder.MoveToImmutable();   // no copy; requires Count == Capacity, otherwise use ToImmutable()
```

## Make sure it round-trips

The cheapest protection is a generic round-trip test for every contract type, run with the **same
`JsonSerializerOptions`** your app uses. Differences in options (naming policy, converters,
`RespectNullableAnnotations`) are a classic source of "works in the test, fails in production".

```csharp
[TestClass]
public sealed class ContractRoundTripTests
{
    private static readonly JsonSerializerOptions Options = AppJson.CreateOptions();   // shared with Program.cs

    public static IEnumerable<object[]> Samples =>
    [
        [new OrderSnapshot(new OrderId(1), [new OrderLine("SKU-1", 2)], ImmutableDictionary<string, string>.Empty.Add("channel", "web"))],
        [new OrderSummary { Lines = [] }],
    ];

    [TestMethod]
    [DynamicData(nameof(Samples))]
    public void Contract_round_trips(object sample)
    {
        var type = sample.GetType();
        var json = JsonSerializer.Serialize(sample, type, Options);
        var copy = JsonSerializer.Deserialize(json, type, Options);

        Assert.AreEqual(json, JsonSerializer.Serialize(copy, type, Options));
    }
}
```

Comparing the re-serialized JSON instead of the objects avoids the fact that collections inside records
compare by reference. For cache entries and messages, the same test also catches the `JsonElement`
problem: add an assertion on the type of a value you read back, and it fails the moment someone puts
`object` into a contract.

And when production throws a `NotSupportedException` for a type that the documentation says is supported,
check the deployment before you write a custom converter. Look at which assembly versions are actually
loaded (for example with `AppDomain.CurrentDomain.GetAssemblies()` in a diagnostics endpoint, or
`dotnet-dump`). A container that starts from the wrong directory, or an old DLL left over in the image,
produces exactly this kind of error.

## Summary

- `System.Text.Json` supports the **immutable collections and their interfaces** in both directions, including
  the source generator.
- **`default(ImmutableArray<T>)`** throws on almost everything. Initialize with `[]`, use `required`, or
  normalize at the boundary.
- **`object` values** come back as `JsonElement`. Keep contracts typed.
- Don't assume support for **frozen collections** or custom collections. Test it.
- Prefer **`ImmutableArray<T>`** over `ImmutableList<T>` for read-heavy data, and **`IReadOnlyList<T>`**
  for wire contracts. Use builders in loops.
- Guard contracts with **round-trip tests** using the app's real serializer options. A "not supported" error
  for a supported type is often a **deployment** problem.
