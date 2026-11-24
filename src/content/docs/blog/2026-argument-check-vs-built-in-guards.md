---
title: Argument.Check vs. ThrowIfNull and friends — when you still need a guard library
date: 2026-11-24
authors: rene
tags: [dotnet, csharp, open-source, argument-check, clean-code]
excerpt: Since .NET 6, ArgumentNullException.ThrowIfNull is built in, and .NET 8 added range and whitespace guards. So why would anyone add a package for guard clauses? An honest comparison of hand-written checks, the built-in throw helpers and Argument.Check, with a decision table at the end.
---


When I started [Argument.Check](https://github.com/RenePeuser/Argument.Check) in 2019, .NET had no
guard helpers at all. Every null check was an `if`, a `throw` and a `nameof`. Today the picture is
different. .NET 6 added `ArgumentNullException.ThrowIfNull`, .NET 7 and 8 added more, and all of
them use the same `CallerArgumentExpression` trick my library relies on.

So it's a fair question, and I get it regularly: **do you still need a guard library?** This post
answers it as honestly as I can, including the cases where my answer is "no, use the built-ins". The
earlier posts cover [getting started](/blog/2026-argument-check-guard-clauses-in-one-line/), [the full
catalogue](/blog/2026-argument-check-the-throw-catalogue/) and [the runtime cost](/blog/2026-argument-check-what-a-guard-costs/).

## What .NET gives you today, helper by helper

Here is every throw helper the BCL ships, next to its Argument.Check counterpart:

| Built-in .NET helper | Since | Argument.Check | Notes |
| --- | --- | --- | --- |
| `ArgumentNullException.ThrowIfNull(x)` | .NET 6 | `Throw.IfNull(x)` | Identical message. |
| `ArgumentException.ThrowIfNullOrEmpty(s)` | .NET 7 | `Throw.IfNullOrEmpty(s)` | Argument.Check also has an overload for collections. |
| `ArgumentException.ThrowIfNullOrWhiteSpace(s)` | .NET 8 | `Throw.IfNullOrWhiteSpace(s)` | |
| `ArgumentOutOfRangeException.ThrowIfNegative(x)` | .NET 8 | `Throw.IfLessThan(x, 0)` | No dedicated sign helpers in Argument.Check. |
| `ArgumentOutOfRangeException.ThrowIfNegativeOrZero(x)` | .NET 8 | `Throw.IfLessOrEqual(x, 0)` | |
| `ArgumentOutOfRangeException.ThrowIfZero(x)` | .NET 8 | `Throw.IfEqualsTo(x, 0)` | Throws `ArgumentException`, not `ArgumentOutOfRangeException`. |
| `ArgumentOutOfRangeException.ThrowIfGreaterThan(x, max)` | .NET 8 | `Throw.IfGreaterThan(x, max)` | |
| `ArgumentOutOfRangeException.ThrowIfGreaterThanOrEqual(x, max)` | .NET 8 | `Throw.IfGreaterOrEqual(x, max)` | |
| `ArgumentOutOfRangeException.ThrowIfLessThan(x, min)` | .NET 8 | `Throw.IfLessThan(x, min)` | |
| `ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(x, min)` | .NET 8 | `Throw.IfLessOrEqual(x, min)` | |
| `ArgumentOutOfRangeException.ThrowIfEqual(x, v)` | .NET 8 | `Throw.IfEqualsTo(x, v)` | Throws `ArgumentException`. |
| `ArgumentOutOfRangeException.ThrowIfNotEqual(x, v)` | .NET 8 | `Throw.IfNotEqualsTo(x, v)` | Throws `ArgumentException`. |
| `ObjectDisposedException.ThrowIf(disposed, this)` | .NET 7 | — | No counterpart. Use the built-in. |
| — (two calls) | | `Throw.IfOutOfRange(x, min, max)` | One call for a range, both bounds inclusive. |
| — | | collections, items, files, directories, types, `If`/`IfNot` predicates | See [the catalogue](/blog/2026-argument-check-the-throw-catalogue/). |

For everything the BCL covers, the two sides match almost one to one. The real differences are in
the messages and the exception types.

### The messages, side by side

Same failing input, both libraries, real output on .NET 10:

```text
null           built-in   Value cannot be null. (Parameter 'name')
               Arg.Check  Value cannot be null. (Parameter 'name')

""             built-in   The value cannot be an empty string. (Parameter 'empty')
               Arg.Check  The string must not be empty. (Parameter 'empty')

"  "           built-in   The value cannot be an empty string or composed entirely of whitespace. (Parameter 'tenant')
               Arg.Check  The string must not be only whitespace. (Parameter 'tenant')

11 > 10        built-in   retries ('11') must be less than or equal to '10'. (Parameter 'retries')
                          Actual value was 11.
               Arg.Check  Value: '11' must not be greater than: '10'. (Parameter 'retries')

0 not in 1–500 built-in   batch ('0') must be greater than or equal to '1'. (Parameter 'batch')
                          Actual value was 0.
               Arg.Check  Value: '0' is not in expected range from '1' to '500'. (Parameter 'batch')

0 == 0         built-in   ArgumentOutOfRangeException: zero ('0') must not be equal to '0'. …
               Arg.Check  ArgumentException: The argument value: '0' was equal to: '0'. (Parameter 'zero')
```

To be fair to the built-ins:

- **Their range messages are better.** They name the parameter *and* repeat the value, and they set
  `ArgumentOutOfRangeException.ActualValue`, so logs and debuggers show the offending value without
  parsing the message. Argument.Check puts the value only into the message text.
- **Their exception types are more precise for equality checks.** `ThrowIfEqual` and `ThrowIfZero`
  throw `ArgumentOutOfRangeException`. Argument.Check's `IfEqualsTo` throws the more general
  `ArgumentException`. If callers catch `ArgumentOutOfRangeException`, that difference matters when
  you migrate.
- **Argument.Check's range message reads more naturally for a range.** One sentence with both bounds
  instead of whichever single bound was violated.

### What it costs, side by side

From [the benchmark post](/blog/2026-argument-check-what-a-guard-costs/), happy path. The first
measurement compared the built-ins with Argument.Check 5.0.7:

| Check | Built-in .NET helper | Argument.Check 5.0.7 |
| --- | ---: | ---: |
| Null, .NET 10 | 1.19 ns | 1.25 ns |
| String null or whitespace, .NET 10 | 0.43 ns | 2.32 ns |
| Range 1–100, .NET 10 | 0.88 ns (two calls) | 3.54 ns |
| Range 1–100, **.NET 9** | 1.08 ns | 36.83 ns, 96 B allocated |

The null check was a tie, everything else a win for the built-ins, and on .NET 9 not a small one.

So I took the hint. **Argument.Check 5.0.8** removes the boxing, the closures and the extra helper
layers, without changing a single public signature or message. Same benchmark, 5.0.7 vs. 5.0.8:

| Check | 5.0.7 | 5.0.8 |
| --- | ---: | ---: |
| Null, .NET 10 | 1.93 ns | **0.78 ns** |
| String null or whitespace, .NET 10 | 0.90 ns | **0.78 ns** |
| Range 1–100, .NET 10 | 3.00 ns | **1.22 ns** |
| String null or whitespace, **.NET 9** | 14.68 ns, 32 B | **1.34 ns, 0 B** |
| Range 1–100, **.NET 9** | 39.83 ns, 96 B | **1.19 ns, 0 B** |

(Separate runs, so compare within a table.) The scalar checks now sit in the same 0.4–1.3 ns range
as the built-in helpers, with **zero allocations** on every runtime. On the happy path, the
performance argument for the built-ins is gone; the other trade-offs below still apply.

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
- **Built for the JIT from day one.** The runtime helpers always threw from a separate, non-inlined
  method and never boxed. Argument.Check caught up in 5.0.8 (see above), so today this is a tie, but
  credit where it's due: the BCL showed the pattern.
- **Everybody knows them.** A new team member doesn't have to look up what `Throw.IfNullOrAny`
  does.

## Microsoft had the same idea, as shared source

Here is the part I enjoyed most while researching this post. Open Microsoft's own
[Agent Framework](https://github.com/microsoft/agent-framework) and look at `ChatClientAgent`:

```csharp
// microsoft/agent-framework · dotnet/src/Microsoft.Agents.AI/ChatClient/ChatClientAgent.cs
_ = Throw.IfNull(chatClient);
// ...
var inputMessages = Throw.IfNull(messages) as IReadOnlyCollection<ChatMessage> ?? messages.ToList();
```

`Throw.IfNull`. Not `ArgumentNullException.ThrowIfNull`. The class behind it lives in
`dotnet/src/Shared/Throw/Throw.cs`:

```csharp
namespace Microsoft.Shared.Diagnostics;

/// <remarks>
/// The main purpose is to reduce code size, improve performance, and standardize exception
/// messages.
/// </remarks>
[ExcludeFromCodeCoverage]
internal static partial class Throw
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    [return: NotNull]
    public static T IfNull<T>([NotNull] T argument,
        [CallerArgumentExpression(nameof(argument))] string paramName = "")
    {
        if (argument is null)
        {
            ArgumentNullException(paramName);
        }

        return argument;
    }

    // IfNullOrWhitespace, IfNullOrEmpty (strings and collections), IfOutOfRange,
    // IfLessThan, IfGreaterThan, IfZero, IfNullOrMemberNull, ...
}
```

In the snapshot I looked at (October 2025), the Agent Framework calls `Throw.IfNull` **337 times**,
across more than a hundred files. The same class, same namespace, also ships in
[dotnet/extensions](https://github.com/dotnet/extensions/blob/main/src/Shared/Throw/Throw.cs), the
repository behind `Microsoft.Extensions.AI` and friends.

Look at what that class does: it **returns the checked value**, takes the name from
`CallerArgumentExpression`, adds `[NotNull]` for flow analysis, covers strings *and* collections and
has a one-call `IfOutOfRange`. Apparently, once a codebase gets big enough, everyone ends up wanting
the checked value back. Nice to be in good company. 😄

I like this a lot, because it shows **the same way of thinking**, arrived at independently: a guard
should be one line, name the parameter by itself, return the checked value and stay out of the way.
Argument.Check has looked like that since 2019, and the same shape shows up in dotnet/extensions
(2023) and the Agent Framework (2025). When different teams land on the same API shape on their own,
that's a good sign the shape is right. Guards apparently just want to look like this.

**Why shared source and not a package?** The repo doesn't spell it out, but the setup suggests
some very sensible reasons:

- **It's shared source, not a package.** A project opts in with `<InjectSharedThrow>true</InjectSharedThrow>`,
  and MSBuild compiles `Throw.cs` into that assembly. Every assembly gets its own private copy.
- **No public API to support forever.** Anything public in a Microsoft package goes through API review
  and has to stay compatible for years. An internal helper can change in the next commit.
- **No dependency diamond.** If ten Microsoft packages depended on a public `Throw` package, every app
  would have to resolve one version of it for all ten. Internal copies can't conflict.
- **It's tuned for their code.** `AggressiveInlining`, the BCL's own throw helpers on .NET 6+ and
  `[ExcludeFromCodeCoverage]` are choices for library internals, not a general-purpose API.

That's a perfectly good reason for Microsoft, and it's also the gap a library like Argument.Check
fills: you get the same style **as a package**, so you don't have to copy a `Throw.cs` into every
repository and keep the copies in sync.

## One style per codebase

Whichever way you go, pick one style and **use only that one**. Two guard styles in one codebase are
worse than either alone.

:::caution
Watch the edge cases when you switch. Argument.Check's `IfOutOfRange(x, 1, 100)` treats both bounds
as **inclusive**, and the built-ins split a range into `ThrowIfLessThan` and `ThrowIfGreaterThan`.
When you migrate, check range semantics test by test, not by method name.
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
| Domain model with many custom guard rules | **Argument.Check** with `If`/`IfNot` or your own named wrappers. |
| Performance-critical code | **Built-ins**, and measure. |
| Validating user input in an API | **None of them.** Use a validation library and return a 400 with details. |

## Summary

- .NET 6–8 closed most of the gap: **null, string and numeric guards are built in** and good.
- Argument.Check still adds three things: **returned values** (check = assignment), **coverage
  beyond null and numbers** (collections, files, types, predicates) and **`netstandard2.0`
  support**.
- The built-ins win on **zero dependencies**, **`ActualValue` on range errors** and **more precise
  exception types**. If they cover your checks, use them.
- Performance is a tie since **Argument.Check 5.0.8**: same 0.4–1.3 ns range on the happy path, zero
  allocations.
- Microsoft's own Agent Framework and dotnet/extensions use an **internal `Throw.IfNull` that returns
  the value**, shipped as shared source: the same way of thinking, arrived at independently.
  Argument.Check offers that style as a package.
- Whatever you choose, choose **one style per codebase** and write the rule down.
- The story of how Argument.Check went from `Func<T>` tricks to `CallerArgumentExpression` is in
  the retrospective [Roslyn analyzers and argument checks](/blog/2017-roslyn-analyzers-and-argument-checks/).
