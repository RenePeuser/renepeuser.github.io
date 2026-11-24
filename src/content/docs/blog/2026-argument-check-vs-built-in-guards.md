---
title: Argument.Check vs. ThrowIfNull and friends — when you still need a guard library
date: 2026-11-24
authors: rene
tags: [dotnet, csharp, open-source, argument-check, clean-code]
excerpt: Since .NET 6, ArgumentNullException.ThrowIfNull is built in, and .NET 8 added range and whitespace guards. So why would anyone add a package for guard clauses? An honest comparison of hand-written checks, the built-in throw helpers, Argument.Check and other guard libraries, with a decision table at the end.
---


When I started [Argument.Check](https://github.com/RenePeuser/Argument.Check) in 2019, .NET had no
guard helpers at all. Every null check was an `if`, a `throw` and a `nameof`. Today the picture is
different. .NET 6 added `ArgumentNullException.ThrowIfNull`, .NET 7 and 8 added more, and all of
them use the same `CallerArgumentExpression` trick my library relies on.

So it's a fair question, and I get it regularly: **do you still need a guard library?** This post
answers it as honestly as I can, including the cases where my answer is "no, use the built-ins". The
earlier posts cover [getting started](/blog/2026-argument-check-guard-clauses-in-one-line/), [the full
catalogue](/blog/2026-argument-check-the-throw-catalogue/) and [the runtime cost](/blog/2026-argument-check-what-a-guard-costs/).

## What .NET gives you today

| API | Since | Checks |
| --- | --- | --- |
| `ArgumentNullException.ThrowIfNull(x)` | .NET 6 | `x` is null |
| `ArgumentException.ThrowIfNullOrEmpty(s)` | .NET 7 | string is null or `""` |
| `ObjectDisposedException.ThrowIf(disposed, this)` | .NET 7 | object is disposed |
| `ArgumentException.ThrowIfNullOrWhiteSpace(s)` | .NET 8 | string is null, `""` or whitespace |
| `ArgumentOutOfRangeException.ThrowIfNegative(x)`, `ThrowIfZero`, `ThrowIfNegativeOrZero` | .NET 8 | numeric sign checks |
| `ArgumentOutOfRangeException.ThrowIfGreaterThan(x, max)`, `ThrowIfLessThan`, `…OrEqual`, `ThrowIfEqual`, `ThrowIfNotEqual` | .NET 8 | comparisons against a limit |

That's a solid set, and the messages are good. These are real outputs on .NET 10:

```text
ArgumentOutOfRangeException: maxRetries ('11') must be less than or equal to '10'. (Parameter 'maxRetries')
                             Actual value was 11.
ArgumentException:           The value cannot be an empty string or composed entirely of whitespace. (Parameter 'name')
```

## The same constructor, three ways

A small service with the typical mix: a dependency, a string, a range and a list.

**Hand-written:**

```csharp
public OrderImporter(IOrderStore store, string tenant, int batchSize, IReadOnlyList<string> channels)
{
    _store = store ?? throw new ArgumentNullException(nameof(store));

    if (string.IsNullOrWhiteSpace(tenant))
        throw new ArgumentException("Tenant must not be empty.", nameof(tenant));
    _tenant = tenant;

    if (batchSize < 1 || batchSize > 500)
        throw new ArgumentOutOfRangeException(nameof(batchSize), batchSize, "Must be 1–500.");
    _batchSize = batchSize;

    ArgumentNullException.ThrowIfNull(channels);
    if (channels.Count == 0 || channels.Any(string.IsNullOrWhiteSpace))
        throw new ArgumentException("At least one channel, none empty.", nameof(channels));
    _channels = channels;
}
```

**Built-in helpers (.NET 8+):**

```csharp
public OrderImporter(IOrderStore store, string tenant, int batchSize, IReadOnlyList<string> channels)
{
    ArgumentNullException.ThrowIfNull(store);
    ArgumentException.ThrowIfNullOrWhiteSpace(tenant);
    ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
    ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, 500);
    ArgumentNullException.ThrowIfNull(channels);
    if (channels.Count == 0 || channels.Any(string.IsNullOrWhiteSpace))
        throw new ArgumentException("At least one channel, none empty.", nameof(channels));

    _store = store;
    _tenant = tenant;
    _batchSize = batchSize;
    _channels = channels;
}
```

**Argument.Check:**

```csharp
public OrderImporter(IOrderStore store, string tenant, int batchSize, IReadOnlyList<string> channels)
{
    _store = Throw.IfNull(store);
    _tenant = Throw.IfNullOrWhiteSpace(tenant);
    _batchSize = Throw.IfOutOfRange(batchSize, 1, 500);

    Throw.IfNullOrEmpty(channels);
    _channels = Throw.IfAnyItemIsNullOrWhitespace(channels).ToList();
}
```

(The two channel checks stay on separate lines on purpose. Nesting them would make the outer
check report the inner *expression*, `Throw.IfNullOrEmpty(channels)`, as the parameter name.)

The built-ins already remove most of the noise. What's left are three differences, and they're the
real reasons to pick one or the other.

### Difference 1: the built-ins return `void`

`ThrowIfNull` is a statement. You check, then assign in a separate line, and nothing guarantees that
the two lines talk about the same variable. Every `Throw.*` helper returns the checked value, so the
check *is* the assignment. That's a small thing per line and a big thing across a codebase with a few
hundred constructors.

### Difference 2: the built-ins stop at null, strings and numbers

Collections, item checks, allow lists, files, directories, types and custom predicates aren't
covered. In the example above, the channel check falls back to a hand-written `if` even on .NET 8.
Argument.Check covers those with the same contract and the same message style. See [the
catalogue](/blog/2026-argument-check-the-throw-catalogue/) for the full list.

### Difference 3: the built-ins need .NET 6, 7 or 8

If you maintain a library that targets `netstandard2.0` because it's consumed from .NET Framework,
Unity or older Xamarin apps, none of these APIs exist. Argument.Check targets `netstandard2.0` and
ships its own copy of `CallerArgumentExpressionAttribute` for those targets, so the same guard
lines compile everywhere. (You still need a C# 10 compiler, which any current SDK provides.)

## Where the built-ins win

I'd be a poor advocate if I left these out:

- **No dependency.** A package reference is something to update, audit and explain. For a codebase
  that only needs null and string checks on .NET 8+, the built-ins are enough. That's a lot of
  codebases.
- **Built for the JIT.** The runtime helpers throw from a separate, non-inlined method. The calling
  method stays small, so the JIT can inline it more easily. [The benchmark
  post](/blog/2026-argument-check-what-a-guard-costs/) shows where that's measurable and where it
  isn't.
- **Allocation-free generic comparisons.** `ThrowIfGreaterThan<T>` is constrained to
  `IComparable<T>`, so an `int` stays an `int`. Argument.Check's range helpers use the non-generic
  `IComparable`, which boxes value types: 96 B per range check on .NET 9. (The .NET 10 JIT removes
  those boxes, but not every consumer runs on .NET 10.)
- **Everybody knows them.** A new team member doesn't have to look up what `Throw.IfNullOrAny`
  does.

## Other guard libraries

Argument.Check isn't the only option. The two you'll meet most often:

| | Argument.Check | Ardalis.GuardClauses | CommunityToolkit.Diagnostics |
| --- | --- | --- | --- |
| Style | `Throw.IfNull(x)` | `Guard.Against.Null(x)` | `Guard.IsNotNull(x)` |
| Returns the value | Yes | Yes | No |
| Name from `CallerArgumentExpression` | Yes | Yes (current versions) | Yes (current versions) |
| Extending it | `Throw.If`/`IfNot` with a predicate, or your own wrapper | Extension methods on `IGuardClause` | Write your own helpers |
| Files and directories | Yes | No | No |
| Focus | Small, readable API for app and library code | Domain-driven style, very extensible | High-performance helpers, part of the .NET Community Toolkit |

They're all reasonable choices. Pick the one whose naming your team reads most naturally, and then
**use only that one**. Two guard styles in one codebase are worse than either alone.

:::caution
Guard libraries don't agree on edge cases. Argument.Check's `IfOutOfRange(x, 1, 100)` treats both
bounds as **inclusive**. Other libraries have range helpers where the upper bound is exclusive. When
you migrate between libraries, check range semantics test by test, not by method name.
:::

## Mixing them is fine, inside one rule

You don't have to choose all-or-nothing. A pragmatic rule I've used:

- **Applications on .NET 8+:** built-ins for null, string and numeric checks. Argument.Check for
  the rest (collections, files, types, custom rules) when those checks show up more than a handful of
  times.
- **Libraries that target `netstandard2.0`:** Argument.Check everywhere, because the built-ins
  aren't available on every target.
- **Hot paths** (tight loops, per-item processing): neither. Validate once at the boundary and let
  the inner code trust its inputs.

Write the rule down, and if it matters to you, enforce it. An architecture test or a banned-API
analyzer can flag `ArgumentNullException.ThrowIfNull` in a project that decided to use one style
only. That's the same idea as [self-defending codebases](/blog/2026-self-defending-codebases/).

## Decision table

| Your situation | Recommendation |
| --- | --- |
| .NET 8+, only null and string checks | **Built-ins.** No package needed. |
| .NET 8+, many collection, file or custom checks | **Argument.Check** for one consistent style that returns values. |
| Library targeting `netstandard2.0` / .NET Framework | **Argument.Check.** The built-ins don't exist there. |
| Domain model with many custom guard rules | Ardalis.GuardClauses or Argument.Check wrappers. Both extend well. |
| Performance-critical code | Built-ins or CommunityToolkit.Diagnostics, and measure. |
| Validating user input in an API | **None of them.** Use a validation library and return a 400 with details. |

## Summary

- .NET 6–8 closed most of the gap: **null, string and numeric guards are built in** and good.
- Argument.Check still adds three things: **returned values** (check = assignment), **coverage
  beyond null and numbers** (collections, files, types, predicates) and **`netstandard2.0`
  support**.
- The built-ins win on **zero dependencies**, **JIT-friendly throw helpers** and **allocation-free
  generic comparisons**. If they cover your checks, use them.
- Whatever you choose, choose **one style per codebase** and write the rule down.
- The story of how Argument.Check went from `Func<T>` tricks to `CallerArgumentExpression` is in
  the retrospective [Roslyn analyzers and argument checks](/blog/2017-roslyn-analyzers-and-argument-checks/).
