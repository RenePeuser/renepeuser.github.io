---
title: Out parameters vs. result types
date: 2026-11-24
authors: rene
tags: [dotnet, csharp, api-design, code-smells]
excerpt: A method with four `out` parameters is hard to call, easy to misuse and impossible to extend. Records, tuples and small result types say the same thing more clearly, and the Try pattern is the one place where `out` still earns its keep.
---


You'll still find advice in older codebases and wikis that boils down to "return the main value and
pass everything else out via `out`". The result looks like this:

```csharp
public string GetResult(out bool isValid, out bool isCached, out bool isPartial, out bool hasWarnings)
```

It compiles, it works, and every caller pays for it. In this post I'll go through what's wrong with
`out` parameters, what I use instead (records, tuples, result types), and why the Try pattern is the
one case where `out` is perfectly fine.

## The problem: inputs that are really outputs

Here's a realistic example from device communication: parsing a status telegram from a machine
controller.

```csharp
public bool ParseStatusTelegram(
    ReadOnlySpan<byte> data,
    out int axis,
    out double position,
    out double velocity,
    out bool isMoving,
    out string? error)
{
    axis = 0; position = 0; velocity = 0; isMoving = false; error = null;

    if (data.Length < 18)
    {
        error = "Telegram too short";
        return false;
    }

    axis     = data[1];
    position = BitConverter.ToDouble(data[2..10]);
    velocity = BitConverter.ToDouble(data[10..18]);
    isMoving = (data[0] & 0x01) != 0;
    return true;
}
```

And the caller:

```csharp
if (parser.ParseStatusTelegram(buffer, out var axis, out var velocity, out var position,
                               out var moving, out var error))
{
    display.Show(axis, position, velocity, moving);
}
else
{
    logger.LogWarning("Invalid telegram: {Error}", error);
}
```

Did you spot the bug? `velocity` and `position` are swapped. Both are `double`, so the compiler is
happy, and the display shows the speed as the position. That's the first of several problems:

- **Same-typed outputs are easy to swap**, and nothing catches it.
- **The signature lies about direction.** Parameters read as inputs. Here, one is an input and five
  are outputs, and you have to read the keywords carefully to tell them apart.
- **Every caller declares a pile of variables**, even for values it doesn't care about (`out _`
  helps a bit).
- **Extension breaks every caller.** Adding a sixth value means a new parameter and touching every call
  site, or adding an overload.
- **The values belong together but don't travel together.** You can't return them from another
  method, store them in a list, or log them as one thing without inventing a type after all.
- **Inconsistent states are possible.** `error` is set on failure, `position` is set on success, and
  nothing in the signature says which combinations are valid.
- **They don't work with `async`.** An `async` method can't have `out` parameters (CS1988), and you
  can't use them inside lambdas either. The first time the parser has to become async, the signature
  has to change anyway.

## Why it happens

`out` is old. Before C# 7 there were no value tuples, before C# 9 no records, and writing a class
with a constructor and four read-only properties was enough ceremony that `out` felt lighter. The
BCL also uses it (`int.TryParse`, `Dictionary.TryGetValue`), so it looks like the official way to
return more than one value.

Today a named result costs one line.

## Fix 1: a record for public methods

If a method returns several values that belong together, they're a concept. Give the concept a name:

```csharp
namespace Factory.Telegrams;

public sealed record AxisStatus(int Axis, double Position, double Velocity, bool IsMoving);
```

```csharp
public AxisStatus ParseStatus(ReadOnlySpan<byte> data) => new(
    Axis:     data[1],
    Position: BitConverter.ToDouble(data[2..10]),
    Velocity: BitConverter.ToDouble(data[10..18]),
    IsMoving: (data[0] & 0x01) != 0);
```

Callers get one value, with names, and can pass it around:

```csharp
var status = parser.ParseStatus(buffer);
display.Show(status);
```

Adding a field later means adding a property. Existing callers keep compiling. Records also give you
value equality, a readable `ToString()` for logging, and `with` expressions for tests.

## Fix 2: a tuple for private helpers

For a private method with two or three values that nobody outside the class sees, a named tuple is
enough:

```csharp
private static (double Min, double Max) GetTravelRange(AxisConfiguration config) =>
    (config.SoftLimitLow, config.SoftLimitHigh);

var (min, max) = GetTravelRange(config);
```

My rule: tuples are fine **inside** a class. As soon as a tuple appears in a public signature, or has
more than three elements, it's a record waiting to be written. Tuple element names are only compiler
metadata. They don't survive reflection or serialization, and an `(int, int)` from one method is the
same type as an unrelated `(int, int)` from another.

## Fix 3: a result type when it can fail

The telegram parser can fail, and the failure is expected (noisy line, truncated telegram). That's not
an exception case, and `bool` plus `out string? error` is the out-parameter version of a result type.
So write the result type:

```csharp
namespace Factory.Telegrams;

public abstract record ParseResult
{
    private ParseResult() { }   // closed hierarchy: only the nested types below

    public sealed record Success(AxisStatus Status) : ParseResult;
    public sealed record Failure(string Reason) : ParseResult;
}
```

```csharp
public ParseResult Parse(ReadOnlySpan<byte> data)
{
    if (data.Length < 18)
        return new ParseResult.Failure($"Telegram too short: {data.Length} bytes");

    if (data[0] is not StatusTelegramMarker)
        return new ParseResult.Failure($"Unexpected telegram type 0x{data[0]:X2}");

    return new ParseResult.Success(ParseStatus(data));
}
```

The caller can't get at the status without handling the failure:

```csharp
switch (parser.Parse(buffer))
{
    case ParseResult.Success(var status):
        display.Show(status);
        break;

    case ParseResult.Failure(var reason):
        logger.LogWarning("Invalid telegram: {Reason}", reason);
        break;
}
```

The invalid states are gone. There's no "success with an error message" and no "failure with a
position of 0".

If you have many operations with the same shape, a generic `Result<T>` saves you writing one hierarchy
per method:

```csharp
public sealed record Result<T>
{
    private Result(bool isSuccess, T? value, string? error) =>
        (IsSuccess, Value, Error) = (isSuccess, value, error);

    [MemberNotNullWhen(true, nameof(Value))]
    [MemberNotNullWhen(false, nameof(Error))]
    public bool IsSuccess { get; }

    public T? Value { get; }
    public string? Error { get; }

    public static Result<T> Ok(T value) => new(true, value, null);
    public static Result<T> Fail(string error) => new(false, default, error);

    public TOut Match<TOut>(Func<T, TOut> onSuccess, Func<string, TOut> onFailure) =>
        IsSuccess ? onSuccess(Value) : onFailure(Error);
}
```

The `MemberNotNullWhen` attributes let the [nullability analysis](/blog/2026-nullability-warnings/)
know that `Value` is set after a successful `IsSuccess` check, so callers don't need `!`. (The single
private constructor matters: two constructors taking `T` and `string` would be ambiguous for a
`Result<string>`.)

You don't have to write this yourself. Libraries like OneOf, FluentResults or ErrorOr do the same with
more features. In minimal APIs, `Results<Ok<T>, NotFound, ValidationProblem>` is the HTTP flavour of the
same idea, see [exception handling best practices](/blog/2026-exception-handling-best-practices/).

## When `out` is fine: the Try pattern

There's one shape where `out` is still the best option, and the BCL uses it everywhere:

```csharp
public bool TryGetCalibration(AxisId axis, [NotNullWhen(true)] out Calibration? calibration)
```

```csharp
if (calibrations.TryGetCalibration(axis, out var calibration))
{
    position = calibration.Apply(rawPosition);
}
```

That's fine because it follows a narrow contract that every .NET developer knows:

- The method name starts with `Try`.
- It returns `bool`, and there's **exactly one** `out` parameter.
- Failure is expected and carries no information beyond "didn't work".
- There are no other side effects.
- It reads naturally in an `if`, and `[NotNullWhen(true)]` tells the compiler the value is set on
  success.

It's also allocation-free, which matters in hot paths such as parsing thousands of telegrams per
second. If you need a reason for the failure, or more than one output, you've left the Try pattern and
should return a result type.

`Deconstruct` methods are the other legitimate use of `out`. They exist so that `var (min, max) = range;`
works, and nobody calls them directly.

## Comparison

| | Multiple `out` | Tuple | Record | Result type | Try pattern |
|---|---|---|---|---|---|
| Outputs have names at the call site | ⚠️ only variable names | ✅ | ✅ | ✅ | ✅ (one value) |
| Same-typed values can't be swapped | ❌ | ⚠️ | ✅ | ✅ | n/a |
| Can be passed on, stored, logged | ❌ | ⚠️ | ✅ | ✅ | ❌ |
| Extensible without breaking callers | ❌ | ❌ | ✅ | ✅ | ❌ |
| Models failure with a reason | ❌ | ❌ | ❌ | ✅ | ❌ |
| Works with `async` | ❌ | ✅ | ✅ | ✅ | ❌ |
| Allocation-free | ✅ | ✅ | ⚠️ unless `record struct` | ⚠️ | ✅ |
| Where I use it | nowhere | private helpers | public multi-value returns | expected failures | lookups, parsing, hot paths |

## Pitfalls

**Tuples in public APIs.** `public (bool, string, int) Validate(...)` has all the problems of `out`
apart from the declaration noise. Use a record.

**Result types for everything.** Wrapping every method in `Result<T>` turns your code into
`if (!r.IsSuccess) return Result<X>.Fail(r.Error)` on every line. Result types are for **expected**
outcomes the caller should handle. Bugs and infrastructure failures are still exceptions.

**A Try method that also throws, or has two outs.** `TryConnect(out Connection c, out string error)`
breaks the contract callers rely on. Return a result type instead.

**`ref` used as a second return channel.** `ref` has the same problems as `out` plus mutation of
the caller's variable. Keep it for performance-critical struct code where you've measured the copy.

**Hiding failure in default values.** Returning an `AxisStatus` with `Axis = -1` on failure is just
`out bool` in disguise. If it can fail, the type should say so.

## Enforce it

- **CA1021** ("Avoid out parameters") flags `out` parameters in public members. It's off by default;
  turn it on and suppress it at your Try-pattern methods, which is the documented exception.
- **CA1045** does the same for `ref` parameters.
- In code review, the question "could this be a record?" catches most new cases. It's on my
  [code review checklist](/blog/2026-code-review-checklist/).

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA1021.severity = warning
dotnet_diagnostic.CA1045.severity = warning
dotnet_code_quality.CA1021.api_surface = public
```

## Summary

- Several `out` parameters mean **outputs disguised as inputs**: same-typed values get swapped,
  callers drown in variables, and every extension breaks the signature.
- Use a **record** for public methods that return several values, and a **named tuple** for small
  private helpers.
- Use a **result type** when failure is expected and carries information. Make invalid states
  unrepresentable.
- The **Try pattern** (`bool TryX(..., out T value)` with exactly one `out`) is fine, especially in
  hot paths.
- Turn on **CA1021/CA1045** and let the build ask the question for you.
