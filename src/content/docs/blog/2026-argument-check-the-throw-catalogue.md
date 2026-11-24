---
title: The Throw catalogue — every check in Argument.Check, with real messages
date: 2026-11-24
authors: rene
tags: [dotnet, csharp, open-source, argument-check, clean-code]
excerpt: Null checks are the easy part. The interesting guards are the ones for strings, collections, ranges, files and types, plus your own rules in one line. A tour of every Throw helper in Argument.Check, grouped by what you check, with the exact exception each one throws and the handful of details you should know before you rely on them.
---


Most guard libraries are sold on `IfNull`. That's the check you need most often, but it's also the
one .NET now ships out of the box. The value of a guard library is everything *around* null: is the
string blank, is the list empty, does the file exist, is the value in range, is it the type I
expect?

This post is a tour of every helper in [Argument.Check](https://github.com/RenePeuser/Argument.Check),
grouped by what you're checking. Every message below is the **real output** of the library, captured
from a small console app against the current source. If you haven't used the library yet, start with
[the getting-started post](/blog/2026-argument-check-guard-clauses-in-one-line/).

All helpers share one contract: they check, throw a standard `Argument*Exception` with the parameter
name taken from your call site, and **return the checked value**.

## Strings

| Helper | Throws when | Exception |
| --- | --- | --- |
| `IfNullOrEmpty(s)` | `s` is null or `""` | `ArgumentNullException` / `ArgumentException` |
| `IfNullOrWhiteSpace(s)` | `s` is null, `""` or only whitespace | `ArgumentNullException` / `ArgumentException` |
| `IfEmpty(s)` / `IfNotEmpty(s)` | `s` is (not) `""` | `ArgumentException` |
| `IfWhitespace(s)` | `s` is only whitespace | `ArgumentException` |
| `IfLengthIs(s, n)` / `IfLengthIsNot(s, n)` | `s.Length` is (not) `n` | `ArgumentOutOfRangeException` |

`IfNullOrWhiteSpace` is the one you'll use most. It runs three checks in order, so the message tells
you *which* way the string was bad:

```csharp
public Customer(string name)
{
    Name = Throw.IfNullOrWhiteSpace(name);
}
```

```text
name = null  → ArgumentNullException: Value cannot be null. (Parameter 'name')
name = ""    → ArgumentException:     The string must not be empty. (Parameter 'name')
name = "   " → ArgumentException:     The string must not be only whitespace. (Parameter 'name')
```

Fixed-length codes are a natural fit for the length checks:

```csharp
var countryCode = Throw.IfLengthIsNot(request.CountryCode, 2);
// ArgumentOutOfRangeException: String length: 'DEU' is not as expected. Expected value: '2'. (Parameter 'request.CountryCode')
```

Note that the message shows the *string*, not its length. For a country code that's exactly what you
want to see in a log. For a password field it isn't. See [Pitfalls](#pitfalls).

## Collections

| Helper | Throws when | Exception |
| --- | --- | --- |
| `IfNullOrEmpty(items)` | the sequence is null or has no items | `ArgumentNullException` / `ArgumentException` |
| `IfEmpty(items)` / `IfNotEmpty(items)` | the sequence has (no) items | `ArgumentException` |
| `IfNullOrAnyItemIsNull(items)` | the sequence is null or contains a null item | `ArgumentNullException` |
| `IfAnyItemIsNullOrWhitespace(strings)` | any string in the sequence is null or whitespace | `ArgumentException` |
| `IfNullOrAny(items, predicate)` | the sequence is null or any item matches `predicate` | `ArgumentNullException` / `ArgumentException` |
| `IfContains(value, source)` / `IfNotContains(value, source)` | `value` is (not) in `source` | `ArgumentException` |

The item-level checks save you a loop and a hand-written message each time:

```csharp
public Product(string sku, IReadOnlyList<string> tags)
{
    Sku = Throw.IfNullOrWhiteSpace(sku);
    Tags = Throw.IfAnyItemIsNullOrWhitespace(tags).ToList();
}
```

```text
tags = ["shoes", " ", "sale"] → ArgumentException: At least one string in the enumeration 'shoes, ,sale' was null or a whitespace. (Parameter 'tags')
```

`IfNotContains` is the "allow list" check. Its argument order reads naturally, value first, then the
set it has to be in:

```csharp
private static readonly string[] SupportedCurrencies = ["EUR", "USD", "GBP"];

public Money(decimal amount, string currency)
{
    Amount = amount;
    Currency = Throw.IfNotContains(currency, SupportedCurrencies);
}
```

```text
currency = "CHF" → ArgumentException: The argument 'CHF' is not contained in the enumeration. (Parameter 'currency')
```

:::tip
For allow lists that are checked on a hot path, pass a `HashSet<string>` as the source. The helper
calls `Contains` on the sequence, so a hash set gives you O(1) lookups instead of a linear scan.
:::

## Ranges and comparisons

| Helper | Throws when | Exception |
| --- | --- | --- |
| `IfOutOfRange(value, min, max)` | `value < min` or `value > max` (bounds are **inclusive**) | `ArgumentOutOfRangeException` |
| `IfGreaterThan(value, limit)` / `IfGreaterOrEqual(value, limit)` | `value >` / `>= limit` | `ArgumentOutOfRangeException` |
| `IfLessThan(value, limit)` / `IfLessOrEqual(value, limit)` | `value <` / `<= limit` | `ArgumentOutOfRangeException` |
| `IfEqualsTo(value, other)` / `IfNotEqualsTo(value, other)` | `value` is (not) equal to `other` | `ArgumentException` |

The comparison helpers work for anything that implements `IComparable`: numbers, `decimal`,
`DateTime`, `TimeSpan`, `string`, your own value objects.

```csharp
public RetryPolicy(int maxRetries, TimeSpan delay)
{
    MaxRetries = Throw.IfOutOfRange(maxRetries, 0, 10);
    Delay = Throw.IfLessThan(delay, TimeSpan.Zero);
}
```

```text
maxRetries = 11 → ArgumentOutOfRangeException: Value: '11' is not in expected range from '0' to '10'. (Parameter 'maxRetries')
maxRetries = 10 → fine, both bounds are inclusive
```

Read the names as "throw if": `IfLessThan(delay, TimeSpan.Zero)` means *throw if the delay is
negative*. That's the most common source of inverted checks when people switch from `Assert`-style
APIs, where the name states what must be *true*.

## Files and directories

| Helper | Throws when | Exception |
| --- | --- | --- |
| `IfNotExists(info)` | the file or directory doesn't exist | `ArgumentException` |
| `IfExists(info)` | the file or directory already exists | `ArgumentException` |

Both take a `FileSystemInfo`, so they work for `FileInfo` and `DirectoryInfo`, and the message says
which one it was:

```csharp
public static async Task<int> ImportAsync(FileInfo source, DirectoryInfo archive)
{
    Throw.IfNotExists(source);
    Throw.IfNotExists(archive);

    var target = new FileInfo(Path.Combine(archive.FullName, source.Name));
    Throw.IfExists(target);   // never overwrite an archived file silently

    // ...
}
```

```text
→ ArgumentException: The file: 'C:\import\prices.json' does not exists. (Parameter 'source')
→ ArgumentException: The file: 'D:\archive\prices.json' already exists. (Parameter 'target')
```

That's the kind of check CLI tools and import jobs need constantly, and the full path in the
message saves a round trip to the logs.

:::caution
A file check is a snapshot. Between `IfNotExists` and the actual `File.Open`, another process can
delete the file. Use the guard for a clear early error message, and still handle `IOException` where
you open the file.
:::

## Types and interfaces

| Helper | Throws when | Exception |
| --- | --- | --- |
| `IfTypeIsNot<T>(obj)` / `IfTypeIs<T>(obj)` | `obj` is (not) a `T` | `ArgumentException` |
| `IfNotInterface<T>()` / `IfInterface<T>()` | the type `T` is (not) an interface | `ArgumentException` |
| `IfNotInterface<T>(obj)` / `IfInterface<T>(obj)` | `obj` does (not) implement `T` | `ArgumentException` |

These are mostly for plug-in hosts and generic infrastructure, where types arrive as `object` or as
type parameters:

```csharp
public void Register<TService>(object implementation) where TService : class
{
    Throw.IfNotInterface<TService>();               // services are registered by interface
    Throw.IfTypeIsNot<TService>(implementation);    // and the instance has to implement it

    _registrations[typeof(TService)] = implementation;
}
```

```text
Register<string>(…)       → ArgumentException: Type: 'System.String' must be an interface.
Register<IDisposable>("x") → ArgumentException: The given type: 'System.String' is not the expected type: 'System.IDisposable'. (Parameter 'implementation')
```

The parameterless overloads check a *type*, not an argument, so their exception has no `ParamName`.

## Your own rules: `If` and `IfNot`

When no built-in helper fits, `Throw.If` and `Throw.IfNot` take a predicate and a message:

```csharp
public Sku(string value)
{
    Value = Throw.IfNot(value,
        v => v.Length <= 10 && v.All(c => char.IsUpper(c) || char.IsDigit(c) || c == '-'),
        "A SKU has at most 10 characters: upper-case letters, digits and '-'.");
}
```

```text
value = "abc-1" → ArgumentException: A SKU has at most 10 characters: upper-case letters, digits and '-'. (Parameter 'value')
```

You write the message once, at the rule. The parameter name still comes from the call site. `If`
throws when the predicate is `true`, `IfNot` when it's `false`. Pick whichever lets you phrase the
predicate as the rule rather than its negation.

If a rule is used in more than one place, give it a name instead of copying the lambda:

```csharp
internal static class Guard
{
    public static string IfInvalidSku(string value,
        [CallerArgumentExpression(nameof(value))] string name = "") =>
        Throw.IfNot(value, IsValidSku, "A SKU has at most 10 characters: upper-case letters, digits and '-'.", name);

    private static bool IsValidSku(string v) =>
        v.Length <= 10 && v.All(c => char.IsUpper(c) || char.IsDigit(c) || c == '-');
}
```

Forwarding `name` explicitly is the one case where passing `argumentName` yourself is correct.
Without it, every message would report `'value'`, the parameter of your wrapper.

## Pitfalls

These are real behaviours of the current version, worth knowing before you lean on them.

**Use the `IfNullOr…` variant whenever null is possible.** The single-purpose helpers (`IfEmpty`,
`IfWhitespace`, `IfLengthIs`, `IfNotExists`, `IfTypeIsNot`, `If` …) call `IfNull` internally, but
without forwarding your parameter name. A null then produces the helper's own name:

```text
Throw.IfEmpty(nullString)        → ArgumentNullException: Value cannot be null. (Parameter 'argument')
Throw.IfNullOrEmpty(nullString)  → ArgumentNullException: Value cannot be null. (Parameter 'nullString')
```

`IfNullOrEmpty` and `IfNullOrWhiteSpace` forward the name correctly. So either pick those, or
call `IfNull` first.

**Messages contain values. Think about what's in them.** `IfOutOfRange`, `IfEqualsTo`,
`IfLengthIs`, `IfContains` and `IfAnyItemIsNullOrWhitespace` put the value, or the whole list,
into the message. That's great for an order quantity and bad for an API key, a password or a
customer's e-mail address, because exception messages end up in logs. For secrets, use `Throw.IfNot`
with a message that describes the rule without echoing the value.

**`IfNullOrAny` names the predicate by its method name.** The message reads *"must not contain any
items that satisfy the given predicate: '…'"*, and for a lambda that's a compiler-generated name such
as `<Main>b__0_24`. If you want a readable message, check with `Throw.IfNot(items, i => !i.Any(...),
"…")` instead and write the message yourself.

**`IComparable`, not `IComparable<T>`.** The range helpers are constrained to the non-generic
interface, so they work for every comparable type. Up to version 5.0.7 that meant boxing for value
types like `int`. Since 5.0.8 the comparison goes through `Comparer<T>.Default`, which uses
`IComparable<T>` when it's there, so an `int` stays an `int`. The numbers are in
[the next post](/blog/2026-argument-check-what-a-guard-costs/).

## Summary

- Beyond null, Argument.Check covers **strings, collections, ranges, files, types** and **custom
  predicates**, all with the same check-throw-return contract.
- The messages contain the **offending value**, the **file path** or the **list content**, which is
  what you need when reading a log. Keep secrets out of them.
- **Inclusive** range bounds, `FileSystemInfo` for files *and* directories, and "throw if" naming
  are the three details to remember.
- When null is possible, prefer **`IfNullOrEmpty` / `IfNullOrWhiteSpace`** over the single-purpose
  helpers so the parameter name stays yours.
- Next: [what all of this costs at runtime](/blog/2026-argument-check-what-a-guard-costs/), measured
  with BenchmarkDotNet.
