---
title: What a guard clause costs — benchmarking Argument.Check against hand-written checks
date: 2026-11-24
authors: rene
tags: [dotnet, csharp, open-source, argument-check, performance, benchmarkdotnet]
excerpt: A helper method for every check, isn't that slower than an if? I measured it with BenchmarkDotNet on .NET 10, comparing hand-written guards, the built-in ThrowIfNull family and Argument.Check. Most checks cost the same as an if. Two didn't, the reasons are worth knowing for any library you write, and version 5.0.8 fixed both without breaking anything.
---


Every time I show [Argument.Check](https://github.com/RenePeuser/Argument.Check) to a team, someone
asks the same question: *"Isn't a method call per check slower than a plain `if`?"* It's a good
question. Guard clauses run on every call, including in code paths that are executed millions of
times, so their cost is paid on the happy path, not just when something goes wrong.

The question also has history. The library started in 2019 on top of `Func<T>` tricks whose whole
purpose was to make the happy path cheap. The retrospective [Roslyn analyzers and argument
checks](/blog/2017-roslyn-analyzers-and-argument-checks/) tells that story. This post skips the
history and answers the question with numbers for the library as it is today.

## Why it's cheap by design

The expensive part of a guard clause used to be the **parameter name**. Before C# 10, a library that
wanted to report it without `nameof` had three options, all bad on the happy path:

| Approach | Happy-path cost |
| --- | --- |
| `Expression<Func<T>>`: `Check.NotNull(() => name)` | Builds an expression tree on **every** call |
| `Func<T>` closure: `Throw.IfNull(() => name)` | Allocates a closure and a delegate on every call |
| Stack trace inspection | Walks the stack (on failure only, but fragile in release builds) |

Since October 2021 Argument.Check uses `CallerArgumentExpression` instead. The compiler rewrites
your call at compile time:

```csharp
// What you write
_repository = Throw.IfNull(repository);

// What the compiler emits
_repository = Throw.IfNull(repository, "repository");
```

The name is a string literal in your assembly. No delegate, no expression tree, no reflection. What's
left is a method call, a null check and a return, which is about as small as a method gets.

## The benchmark

I compared three variants for four typical checks: a hand-written `if`, the built-in .NET helper
where one exists, and Argument.Check. Each check sits in its own method marked `NoInlining`, so the
benchmark measures a realistic "call a method that guards its argument" instead of letting the JIT
fold everything away.

```csharp
[MemoryDiagnoser]
public class NullCheck
{
    private readonly object _value = new();

    [Benchmark(Baseline = true)]
    public object HandWrittenIf() => Check(_value);
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object Check(object arg)
    {
        if (arg is null) throw new ArgumentNullException(nameof(arg));
        return arg;
    }

    [Benchmark]
    public object ThrowIfNull_BuiltIn() => CheckBuiltIn(_value);
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object CheckBuiltIn(object arg)
    {
        ArgumentNullException.ThrowIfNull(arg);
        return arg;
    }

    [Benchmark]
    public object ArgumentCheck_IfNull() => CheckLib(_value);
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object CheckLib(object arg) => Throw.IfNull(arg);
}
```

The string, range and collection benchmarks follow the same pattern. All of them measure the
**happy path**, because that's the one you pay for on every call.

Setup: BenchmarkDotNet 0.15.8, .NET 10.0.15, x64 RyuJIT, Intel Core i9-13980HX, Windows 11,
in-process toolchain with the default job, release build of Argument.Check from the current source.
The extra .NET 9 run further down used .NET 9.0.23 and BenchmarkDotNet's short job.

## Results

Mean time per call on .NET 10, happy path. Lower is better.

| Check | Hand-written `if` | Built-in .NET helper | Argument.Check | Allocated (Argument.Check) |
| --- | ---: | ---: | ---: | ---: |
| Null (`IfNull`) | 1.43 ns | 1.19 ns | **1.25 ns** | 0 B |
| String (`IfNullOrWhiteSpace`) | 0.49 ns | 0.43 ns | **2.32 ns** | 0 B |
| Range 1–100 (`IfOutOfRange`) | 1.21 ns | 0.88 ns | **3.54 ns** | 0 B |
| 4-item list, no blank strings (`IfAnyItemIsNullOrWhitespace`) | 9.76 ns (loop) | n/a | **19.98 ns** | 24 B |

The same range benchmark on **.NET 9**:

| Check | Hand-written `if` | Built-in .NET helper | Argument.Check | Allocated (Argument.Check) |
| --- | ---: | ---: | ---: | ---: |
| Range 1–100 (`IfOutOfRange`) | 0.65 ns | 1.08 ns | **36.83 ns** | **96 B** |

:::note
Numbers below about 2 ns are at the edge of what BenchmarkDotNet can resolve. The standard
deviations were in the range of 0.3–0.6 ns, so 1.19 vs. 1.43 ns is a tie, not a win. Treat the
differences in the first two rows as "the same" and those in the last three as real.
:::

Three readings:

1. **The null check costs the same as an `if`.** That's the check you write most often, and here the
   library is indistinguishable from hand-written code and from `ArgumentNullException.ThrowIfNull`.
2. **String and range checks cost a couple of nanoseconds more** on .NET 10. Real, but small.
3. **The collection check allocates, and on .NET 9 the range check does too.** That's the finding
   worth a closer look.

## Where the cost comes from

### Layers of small helpers

`IfNullOrWhiteSpace` is built from smaller helpers, which keeps the library easy to maintain:

```csharp
public static string IfNullOrWhiteSpace([NotNull] string? argument,
    [CallerArgumentExpression(nameof(argument))] string argumentName = "")
{
    IfNull(argument, argumentName);
    IfEmpty(argument, argumentName);
    IfWhitespace(argument, argumentName);
    return argument;
}
```

`IfEmpty` and `IfWhitespace` each check for null again before doing their own work. So one call is
four calls and three null checks. The JIT inlines some of that, but methods that contain a `throw`
are less attractive inlining candidates. The built-in `ThrowIfNullOrWhiteSpace` does one
`string.IsNullOrWhiteSpace` call and throws from a separate helper. That's the 2 ns.

`IfOutOfRange` has the same shape, plus one surprise. Here is the chain it runs through:

```csharp
internal static bool IsOutOfRange<T>(this T source, T lowerLimit, T upperLimit) where T : IComparable
{
    Throw.IfLessThan(upperLimit, lowerLimit);   // validates the bounds themselves ...

    return !source.IsInRange(lowerLimit, upperLimit);
}

internal static bool IsInRange<T>(this T source, T lowerLimit, T upperLimit) where T : IComparable
{
    Throw.IfLessThan(upperLimit, lowerLimit);   // ... and validates them again

    return source.IsLessOrEqual(upperLimit) && source.IsGreaterOrEqual(lowerLimit);
}
```

The bounds check protects against `IfOutOfRange(x, 100, 1)`, which is a nice safety net. But it runs
**twice** per call, for bounds that are almost always constants. Together with the two real
comparisons, one range check makes four `CompareTo` calls.

### Boxing through `IComparable`

The range helpers are constrained to the non-generic `IComparable`:

```csharp
public static T IfOutOfRange<T>(T argument, T min, T max, ...) where T : IComparable
```

`IComparable.CompareTo` takes an `object`. For an `int`, every comparison has to **box** the other
value onto the heap. Four comparisons per call means four boxes, 24 bytes each for a boxed `int` on
x64. That's exactly the 96 B the .NET 9 run shows, and boxing is why the check takes 37 ns there.

On .NET 10 the same code allocates nothing and runs in 3.5 ns. The .NET 10 JIT can prove that these
boxes never escape the method and **allocates them on the stack instead of the heap**. The library
didn't change. The runtime got smarter. But that only helps consumers on .NET 10 or newer. An
application on .NET 8 or 9, or on .NET Framework through the `netstandard2.0` build, still pays for
the boxes.

The built-in `ArgumentOutOfRangeException.ThrowIfGreaterThan<T>` is constrained to
`IComparable<T>`, so `CompareTo(int)` never boxes, on any runtime.

### A closure per collection check

The 24 bytes in the collection benchmark come from here:

```csharp
internal static bool IsAnyItem<T>(this IEnumerable<T> source, Predicate<T> check)
{
    return source.Any(item => check(item));
}
```

The lambda captures `check`, so every call allocates a closure object and a delegate. A plain
`foreach` with an early `return` does the same job without allocating anything. That's the hand-written
loop in the benchmark, at half the time.

## The benchmark that measured the wrong thing

While setting this up, I looked at the benchmark project that lives in the Argument.Check repository
itself. One of its methods is this:

```csharp
[Benchmark]
public object Throw_If_Null_Func()
{
    return CheckNull(new object());

    static object CheckNull(object arg)
    {
        return Throw.IfNull(() => arg);
    }
}
```

That's left over from the `Func<T>` era. The `Func<T>` overload is long gone, but the line still
compiles. Since C# 10, a lambda has a natural type, so `T` is inferred as `Func<object>`, and
`Throw.IfNull` now checks that **the delegate** isn't null. It always isn't. The benchmark still runs,
still produces a number, and that number says nothing about the library.

That's an easy mistake to make, and a good reminder: **benchmarks rot like any other code**, and
unlike tests, they don't fail when they rot. A benchmark that hasn't been read in a year should be
treated as suspect.

## Does any of this matter?

Put the numbers in context. One nanosecond is a millionth of a millisecond. A guard clause that costs
a few nanoseconds more runs **a million times** before it adds up to a few milliseconds. In a typical
API request, a single database round trip costs around a millisecond, and a JSON serialization costs
microseconds.

So for constructors, service methods and API boundaries, the cost of the checks is noise, whichever
style you choose. It starts to matter in two places:

- **Tight loops** that check every item of a large collection, millions of times per second.
- **Allocation-sensitive code**, where GC pauses matter more than raw speed (games, trading,
  real-time processing).

In both, the better fix is usually structural: **validate once at the boundary** and let the inner
loop trust its input. That beats any guard implementation.

## Version 5.0.8: as fast as the built-ins

The measurements above turned straight into a to-do list, and that list shipped as
**Argument.Check 5.0.8**. It's a **non-breaking** release: the public API is identical on every
target framework, and all exception types and messages are unchanged, checked with a reflection dump
of the API and a probe that compares 380 exception messages before and after. Only the internals
changed:

- **Comparisons without boxing.** The `IComparable` constraint stays, but comparisons go through
  `Comparer<T>.Default`. It uses `IComparable<T>` when a type implements it (every number,
  `DateTime`, `decimal`…), so value types don't box, and it still falls back to `IComparable` for
  everything else.
- **The bounds are validated once.** No more double `min <= max` check.
- **One check on the happy path.** `IfNullOrWhiteSpace` does a single `string.IsNullOrWhiteSpace` and
  only works out which message to throw when the check fails.
- **Cold-path throw helpers.** Every `throw new …`, including the message formatting, moved into small
  `[DoesNotReturn]`, non-inlined methods. The checking methods stay tiny, the same pattern the runtime's
  own `ThrowIfNull` uses.
- **Loops instead of LINQ** in the collection helpers, with fast paths for lists and arrays. No
  closure, no allocation.

Same benchmark, before (5.0.7) and after (5.0.8), happy path. BenchmarkDotNet 0.15.8, in-process
toolchain, Intel Core i9-13980HX, Windows 11. This is a separate run from the tables above, so compare
within a table, not across tables.

**.NET 9**, where the old version paid most:

| Check | 5.0.7 | 5.0.8 | Allocated 5.0.7 → 5.0.8 |
| --- | ---: | ---: | --- |
| `IfNull` | 3.45 ns | **1.07 ns** | 0 → 0 |
| `IfNullOrWhiteSpace` | 14.68 ns | **1.34 ns** | 32 B → **0 B** |
| `IfOutOfRange` (int) | 39.83 ns | **1.19 ns** | 96 B → **0 B** |
| `IfGreaterThan` (int) | 8.98 ns | **0.81 ns** | 24 B → **0 B** |
| `IfLessThan` (int) | 5.58 ns | **0.35 ns** | 24 B → **0 B** |
| `IfAnyItemIsNullOrWhitespace` (4 items) | 35.10 ns | **12.11 ns** | 88 B → **0 B** |
| `IfNullOrAny` (4 items) | 16.80 ns | **10.17 ns** | 0 → 0 |

**.NET 10**, where the JIT already removed most of the boxing:

| Check | 5.0.7 | 5.0.8 | Allocated 5.0.7 → 5.0.8 |
| --- | ---: | ---: | --- |
| `IfNull` | 1.93 ns | **0.78 ns** | 0 → 0 |
| `IfNullOrWhiteSpace` | 0.90 ns | **0.78 ns** | 0 → 0 |
| `IfOutOfRange` (int) | 3.00 ns | **1.22 ns** | 0 → 0 |
| `IfGreaterThan` (int) | 1.38 ns | **1.13 ns** | 0 → 0 |
| `IfLessThan` (int) | 0.64 ns | **0.60 ns** | 0 → 0 |
| `IfAnyItemIsNullOrWhitespace` (4 items) | 20.76 ns | **12.61 ns** | 24 B → **0 B** |
| `IfNullOrAny` (4 items) | 16.85 ns | **7.30 ns** | 0 → 0 |

The headline: **zero allocations in every check, on every runtime**, and the range check on .NET 9 is
about **33 times faster**. The scalar checks now land in the same 0.4–1.3 ns range as the built-in
helpers measured above. As before, anything below about 2 ns is at the edge of what the benchmark can
resolve, so treat those rows as "as fast as an `if`", not as exact rankings.

One item from my list is still open: **a benchmark that can't rot silently**, compared against a
baseline in CI, so a benchmark measuring the wrong thing stands out.

## Summary

- Thanks to `CallerArgumentExpression`, the parameter name is a **compile-time string literal**:
  no delegates, no expression trees, no reflection on the happy path.
- The **null check costs the same as a hand-written `if`** (≈1.2 ns on .NET 10, no allocation).
  String and range checks cost **about 2 ns more**, because of layered helper calls.
- `IComparable` boxes value types: **96 B and 37 ns per range check on .NET 9**. On .NET 10 the JIT
  stack-allocates the boxes and the cost drops to 3.5 ns with **0 B**. The built-in generic helpers
  never box.
- The collection helpers allocate a **closure per call** (24 B), because they're built on LINQ with
  a capturing lambda.
- Benchmarks rot silently. The repo's own `Throw.IfNull(() => arg)` benchmark now measures a null
  check on a delegate.
- **Version 5.0.8 fixed all of it, non-breaking:** zero allocations in every check on every runtime,
  the .NET 9 range check went from 40 ns to about 1 ns, and the scalar checks now match the
  built-ins.
- For constructors and API boundaries, the cost of **any** guard style is noise. In hot loops,
  validate once at the boundary instead.
- The [comparison with the built-in guards](/blog/2026-argument-check-vs-built-in-guards/) puts these
  numbers next to the other trade-offs.
