---
title: Equality in generic code — why EqualityComparer<T>.Default exists
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, csharp, performance, pitfalls]
excerpt: The == operator doesn't compile for an unconstrained T, object.Equals boxes, a.Equals(b) throws on null, and NaN isn't equal to itself. What EqualityComparer<T>.Default does better, where it belongs, and where a plain == is still the clearer choice.
---

:::note[Series]
Part of the series [*.NET pitfalls*](/series/dotnet-pitfalls/).
:::

"Are these two values equal?" sounds like the easiest question in programming. In C#, the answer depends
on whether you write `==`, `Equals`, `object.Equals` or `ReferenceEquals`, on whether the type is a class,
a struct, a record or a `Nullable<T>`, and on whether you're in generic code. Most of the time the
difference doesn't matter. When it does, you get a bug that survives every unit test with simple data,
or an allocation in a hot loop that shows up as GC pressure.

This post is about the one comparison that behaves consistently across all of those cases:
`EqualityComparer<T>.Default`.

## The problem in generic code

Here's a typical helper: set a field and report whether it changed. You find it in every
`INotifyPropertyChanged` base class and in many caching or change-tracking utilities.

```csharp
protected bool SetField<T>(ref T field, T value)
{
    if (field == value)            // ❌ CS0019: operator '==' cannot be applied to operands of type 'T'
        return false;

    field = value;
    return true;
}
```

For an unconstrained `T`, the compiler doesn't know whether `==` exists, so it refuses. The usual
"fixes" all have a catch:

```csharp
if (field.Equals(value))           // ❌ NullReferenceException if field is null
if (object.Equals(field, value))   // ⚠️ boxes value types: two allocations per call
if (ReferenceEquals(field, value)) // ❌ always false for value types (they're boxed separately)
```

`object.Equals(a, b)` is null-safe, but it takes `object` parameters. For a `T` that's an `int`, a
`decimal` or a struct, both values get boxed on every call. In a setter that runs a few times, nobody
cares. In a comparison inside a loop over a million items, that's two million short-lived allocations.

## The solution

```csharp
protected bool SetField<T>(ref T field, T value)
{
    if (EqualityComparer<T>.Default.Equals(field, value))
        return false;

    field = value;
    return true;
}
```

`EqualityComparer<T>.Default` picks the best available comparison for `T`, once, and caches it:

- If `T` implements **`IEquatable<T>`** (all primitives, `string`, `Guid`, `DateTime`, records, well-written
  structs), it calls `IEquatable<T>.Equals` directly, **without boxing**.
- For **`Nullable<T>`**, it handles `null` on both sides and then compares the underlying values.
- For other types, it falls back to `object.Equals`, which respects overridden `Equals`.
- It's **null-safe** for reference types.

And it's fast. Since .NET Core 2.1, the JIT treats `EqualityComparer<T>.Default` as an intrinsic: for
value types, the call is devirtualized and often inlined, so in generic code specialized for a value
type it ends up as good as a hand-written comparison.

That's also why `Dictionary<TKey, TValue>`, `HashSet<T>`, `List<T>.Contains` and `Array.IndexOf` all use
it internally when you don't pass a comparer.

## A subtle difference: NaN

Here's a case where the answer differs, and it's a good reminder that "equal" has more than one meaning:

```csharp
double a = double.NaN, b = double.NaN;

Console.WriteLine(a == b);                                       // False (IEEE 754)
Console.WriteLine(a.Equals(b));                                  // True
Console.WriteLine(EqualityComparer<double>.Default.Equals(a, b)); // True
```

`==` follows IEEE 754 arithmetic, where NaN isn't equal to anything, not even itself. `Equals` follows
the rules for collections: a value must equal itself, otherwise you could add NaN to a `HashSet<double>`
again and again. For change detection, that's the behaviour you want. With `==`, a property holding
`NaN` would raise `PropertyChanged` on every assignment.

## Where the comparison you get isn't the one you want

`EqualityComparer<T>.Default` is consistent, but it's only as good as the type's own definition of
equality.

**Classes without an `Equals` override compare references.** Two `Customer` instances with the same ID
aren't equal unless the class says so. If you want value semantics, use a `record`, or override `Equals`
and `GetHashCode` and implement `IEquatable<T>`.

**Structs without `IEquatable<T>` are slow.** The default `ValueType.Equals` boxes, and if the struct
contains reference-type fields it falls back to comparing fields via reflection. Make structs
`record struct`, or implement `IEquatable<T>` yourself:

```csharp
public readonly record struct Money(decimal Amount, string Currency);   // IEquatable<Money> generated
```

**Strings use ordinal comparison.** `EqualityComparer<string>.Default` is a case-sensitive, ordinal
comparison. For user input like e-mail addresses or SKUs, you usually want `StringComparer.OrdinalIgnoreCase`,
and you pass it explicitly:

```csharp
var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
```

**Mutable keys.** If a type's `GetHashCode` depends on mutable state and you change it after adding the
object to a `HashSet` or as a dictionary key, the collection can't find it any more. That's not a
comparer problem, but it's the bug people hit right after switching to value equality.

## Custom comparers without a class

When you need a different notion of equality, for example "same product if the SKU matches", you don't
need a whole class any more. Since .NET 8 there's a factory method:

```csharp
var bySku = EqualityComparer<Product>.Create(
    (x, y) => string.Equals(x?.Sku, y?.Sku, StringComparison.OrdinalIgnoreCase),
    p => StringComparer.OrdinalIgnoreCase.GetHashCode(p.Sku));

var unique = products.Distinct(bySku).ToList();
```

If you do write a class, derive from `EqualityComparer<T>` rather than implementing
`IEqualityComparer<T>` directly. The base class also implements the non-generic `IEqualityComparer`
for you.

## Overview

| Comparison | Null-safe | Avoids boxing | Works for unconstrained `T` | Uses `IEquatable<T>` |
|---|---|---|---|---|
| `a == b` | ✅ for reference types and `Nullable<T>` | ✅ | ❌ doesn't compile | ⚠️ uses the operator, if one is defined |
| `a.Equals(b)` | ❌ throws if `a` is null | ⚠️ boxes the argument if `T` lacks `IEquatable<T>` | ✅ | ⚠️ only via constraint |
| `object.Equals(a, b)` | ✅ | ❌ | ✅ | ❌ |
| `ReferenceEquals(a, b)` | ✅ | ❌ and then always false | ✅ | ❌ identity only |
| `EqualityComparer<T>.Default.Equals(a, b)` | ✅ | ✅ | ✅ | ✅ |

## Should you use it everywhere?

I've seen guidelines that recommend wrapping it in extension methods and using those for every
comparison in the codebase:

```csharp
public static class EqualityExtensions
{
    public static bool EqualsTo<T>(this T left, T right) =>
        EqualityComparer<T>.Default.Equals(left, right);

    public static bool NotEqualsTo<T>(this T left, T right) =>
        !EqualityComparer<T>.Default.Equals(left, right);
}
```

I like the helper, and in **generic code** it's a nice readability win. For concrete types I don't
use it. `order.Status == OrderStatus.Paid` or `customerId == other.CustomerId` is perfectly well defined,
doesn't box, and is what every C# developer reads fastest. Records, enums, primitives and strings all
have a sensible `==`.

My rule of thumb:

- **Generic code** (`T` without a known type): `EqualityComparer<T>.Default`, directly or via a helper.
- **Concrete types with a meaningful `==`**: use `==`.
- **Collections and LINQ** that need a non-default notion of equality: pass an explicit comparer.
- **Never** `object.Equals(a, b)` in generic hot paths, and never `ReferenceEquals` when you mean equality.

## Catching it

- **CA1067**: override `Equals(object)` when implementing `IEquatable<T>`.
- **CA1815**: override equality on value types (or, better, use `record struct`).
- **CA1309 / CA1310**: use ordinal string comparison where culture doesn't matter.
- **CA2013**: don't use `ReferenceEquals` with value types. This one catches the "always false" bug from
  above.
- For allocations, a quick [BenchmarkDotNet](https://benchmarkdotnet.org/) run with `[MemoryDiagnoser]`
  makes the boxing of `object.Equals` visible: it shows bytes allocated per operation, where
  `EqualityComparer<T>.Default` shows zero.

## Summary

- In generic code, `==` doesn't compile, `a.Equals(b)` can throw, `object.Equals` boxes and
  `ReferenceEquals` compares identity.
- **`EqualityComparer<T>.Default`** is null-safe, uses `IEquatable<T>` without boxing, handles
  `Nullable<T>`, and is optimized by the JIT. It's what the BCL collections use.
- It treats **`NaN` as equal to itself**, unlike `==`, which is what you want for change detection.
- Its result is only as good as the type's equality: use **records**, implement **`IEquatable<T>`** on
  structs, and pass **explicit string comparers**.
- Use **`EqualityComparer<T>.Create`** (.NET 8+) for ad-hoc comparers.
- For concrete types with a clear `==`, keep using `==`.
