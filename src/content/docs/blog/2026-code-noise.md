---
title: Code noise — comments, regions, prefixes and loops that hide what your code does
date: 2026-11-24
authors: rene
tags: [dotnet, clean-code, readability, linq]
excerpt: Generated XML docs that repeat the property name, #region blocks around a single constructor, m_ prefixes and for-i loops that fill a list one item at a time. None of it is a bug, all of it costs reading time. What to delete, what to keep and how to let the tooling enforce it.
---


Code is read far more often than it's written. That's a cliché, and still most codebases I review
contain a surprising amount of text whose only effect is to **make reading slower**. A comment that
says what the next line says. A `#region` called `Constructor` around a constructor. A field called
`m_strName`. A ten-line loop whose whole job is `Select(x => x.Id)`.

None of that is a bug. That's exactly why it survives code review. This post collects the common
kinds of noise, why each one hurts more than it looks, and what to write instead.

## Noise 1: comments that say nothing

You'll still find "every public member must have an XML doc comment" in many team guidelines. The
result, after a documentation generator or an IDE snippet got involved, looks like this:

```csharp
/// <summary>
/// Gets or sets the name.
/// </summary>
/// <value>The name.</value>
public string Name { get; set; } = "";

/// <summary>
/// Gets the order.
/// </summary>
/// <param name="id"></param>
/// <param name="ct"></param>
/// <returns></returns>
public Task<Order?> GetOrderAsync(OrderId id, CancellationToken ct);

/// <summary>
/// Always returns <c>true</c>.
/// </summary>
public bool IsValid(Order order) => order.Lines.Count > 0;
```

Three kinds of noise in a few lines:

- **Obvious comments** repeat the name. They add zero information and double the length.
- **Empty elements** (`<param name="id"></param>`) exist only to silence a warning.
- **Wrong comments** are the dangerous ones. The code changed, the comment didn't, and now it lies.

The real cost is not the wasted lines. It's that readers learn to **skip comments**. Your eyes treat
the grey block as background. Then the one comment that actually matters ("don't reorder these
calls, the device firmware expects the reset first") gets skipped too.

### What a good comment looks like

A good comment explains **why**, not what. It captures something the code can't say:

```csharp
// The controller drops commands that arrive less than 50 ms after a reset,
// so we wait for the ready signal instead of sending immediately.
await device.WaitForReadyAsync(ct);
await device.SendAsync(command, ct);
```

My rules of thumb:

- **Fix the name first.** If you need a comment to explain what a method does, the method has the
  wrong name or does too much. `ProcessData()` with a comment becomes `ImportSensorReadings()`
  without one.
- **Comment intent, constraints and surprises:** business rules with a source, workarounds for a
  bug in a library (with a link), performance decisions that look odd.
- **XML docs for public APIs that others consume.** A NuGet package or a
  [shared contracts library](/blog/2026-shared-contracts-library/) deserves real documentation:
  what the parameter means, which exceptions are thrown, what `null` means. Application code
  inside one team usually doesn't need a doc comment on every property.
- **Delete commented-out code.** Git remembers it. If you're afraid of losing something, see
  [git reflog as a safety net](/blog/2026-git-reflog-as-a-safety-net/).

## Noise 2: regions as a table of contents

```csharp
public sealed class OrderService
{
    #region Fields
    private readonly IOrderRepository _orders;
    #endregion

    #region Constructor
    public OrderService(IOrderRepository orders) => _orders = orders;
    #endregion

    #region Public methods
    public Task PlaceAsync(PlaceOrder command, CancellationToken ct) => /* ... */ Task.CompletedTask;
    #endregion
}
```

Regions around single members are pure ceremony. Every IDE already shows the structure of a class,
and collapsing code means you have to click before you can read.

Regions in *large* classes are worse, because they're a symptom. When a class needs `#region
Polling`, `#region Alarms` and `#region Program upload` to stay navigable, those regions are
telling you the names of the classes you should extract. Fold them out into real types (see
[state is the enemy](/blog/2026-state-is-the-enemy/) for how to split a large class). The same goes
for `partial` classes used only to spread one huge class across files. `partial` is great for
source generators and generated code, and a smell everywhere else.

The modern version of the example above needs no regions at all:

```csharp
public sealed class OrderService(IOrderRepository orders)
{
    public Task PlaceAsync(PlaceOrder command, CancellationToken ct) => /* ... */ Task.CompletedTask;
}
```

## Noise 3: prefixes and Hungarian notation

```csharp
public class CMachine
{
    private string m_strName;
    private int m_iAxisCount;
    private bool m_bIsRunning;

    public void Start(int iSpeed, string strProgram) { /* ... */ }
}
```

Type prefixes (`str`, `i`, `b`), scope prefixes (`m_`, `g_`, `p`) and class prefixes (`C`, `T`)
come from a time without type information in the editor. Today, hovering shows the type, syntax
highlighting colours fields differently from locals, and the compiler stops you from passing an
`int` where a `string` is expected. The prefixes only add noise, and they **lie after a refactoring**
when `iSpeed` becomes a `double`.

What .NET convention actually uses, and what I'd stick to:

- `PascalCase` for types, methods, properties, constants.
- `camelCase` for locals and parameters.
- `_camelCase` for private fields. One underscore is the one prefix the .NET runtime team and the
  default `.editorconfig` templates agree on, and with primary constructors you often have no
  fields left anyway.
- `I` for interfaces. It's Hungarian, technically, but it's the platform convention and fighting it
  creates more noise than it removes.

More important than prefixes: **write names out**. `var ret = co.Temp;` forces every reader to
decode three abbreviations. `var temperature = controller.CurrentTemperature;` doesn't.

## Noise 4: `for i` and list-building in high-level code

Here's a method I find in some form in nearly every older codebase:

```csharp
public static List<long> GetIds(OrderBatch batch)
{
    List<long> ids = new List<long>();

    for (int i = 0; i < batch.Orders.Count(); i++)
    {
        long id = batch.Orders.ElementAt(i).Id;
        ids.Add(id);
    }

    return ids;
}
```

Count the things a reader has to check: the start index, the `<` vs. `<=`, the increment, whether
`i` is used for anything else, whether the list is modified elsewhere. And there's a hidden bug: if
`Orders` is an `IEnumerable<T>`, `Count()` and `ElementAt(i)` re-enumerate it on every iteration.
That's quadratic, and if the source is a database query it's quadratic round trips.

The method wants to say "the IDs of the orders". So let it:

```csharp
public static IEnumerable<long> GetIds(OrderBatch batch) =>
    batch.Orders.Select(order => order.Id);
```

When the logic is more than a projection, `yield return` keeps the declaration and the production
of values together without a temporary list:

```csharp
public static IEnumerable<SensorReading> ValidReadings(IEnumerable<RawSample> samples)
{
    foreach (var sample in samples)
    {
        if (sample.Quality < SampleQuality.Good)
            continue;

        yield return new SensorReading(sample.SensorId, sample.Value * sample.Scale, sample.Timestamp);
    }
}
```

`for i` is still the right tool where the index *is* the logic: algorithms, neighbours in an array,
working with `Span<T>` in a hot path, writing into a preallocated buffer. That's low-level code.
In high-level business code, an index is noise.

### Lazy vs. materialized

Both versions above are **lazy**: nothing runs until someone enumerates, and every enumeration runs
again. That's a feature, but it changes semantics:

- Don't enumerate a lazy sequence twice when the source is expensive. Materialize once with
  `ToList()` or `ToArray()` at the boundary where you need a stable result.
- Don't return a lazy query over a `DbContext` or a stream that's disposed when the method returns.
- Return `IReadOnlyList<T>` when the caller needs `Count` and indexing, `IEnumerable<T>` when they
  only iterate. For async sources, see [IAsyncEnumerable done right](/blog/2026-iasyncenumerable-done-right/).

### Method syntax or query syntax?

For simple filters and projections, method syntax is shorter. For several nested `from` clauses,
query syntax is far more readable, because the compiler writes the transparent identifiers for you:

```csharp
var specialParameters =
    from project in solution.Projects
    from type in project.Types
    from method in type.Methods
    from parameter in method.Parameters
    where parameter.Name == "special"
    select (type, method, parameter);
```

The same with `SelectMany` chains needs anonymous types at every step and is hard to read. I pick
whichever form reads better for the specific query, and I don't mix both styles in one expression.

And one warning: LINQ makes it easy to write a single expression that does far too much. If a query
needs a comment to be understood, give its parts names, either as local variables or as small
methods.

## Overview

| Noise | Why it hurts | Instead |
|---|---|---|
| Obvious / empty / wrong comments | Readers skip all comments, wrong ones mislead | Good names; comment the *why* |
| Commented-out code | Clutter, never deleted | Delete it, Git remembers |
| `#region` around members | Clicking before reading, hides large classes | Smaller classes, no regions |
| Hungarian / scope prefixes | Noise, lies after refactorings | .NET naming conventions, full words |
| `for i` + `List.Add` | Index noise, off-by-one, hidden re-enumeration | `Select`, `Where`, `yield return` |

## Pitfalls

**Deleting comments that matter.** "No comments" is the wrong lesson. Delete the ones that repeat
the code, keep and improve the ones that explain decisions.

**Turning every loop into a one-liner.** A LINQ chain with side effects inside `Select`, or a
`.ForEach(...)` call with a block body, is not more readable than a `foreach`. Use LINQ for
transforming data, `foreach` for doing things.

**Performance folklore.** "LINQ is slow" is mostly outdated; .NET has optimized the common operators
heavily over the last releases. In a measured hot path, a `for` loop over a `Span<T>` can still win.
Measure first.

**Renaming wars.** Agree on conventions once, write them into `.editorconfig`, and let the formatter
settle it. Arguing about prefixes in every pull request is noise too.

## Let the tooling enforce it

Most of these rules can be checked by the compiler and the formatter:

```ini
# .editorconfig
[*.cs]
# naming: private fields are _camelCase
dotnet_naming_rule.private_fields.symbols = private_fields
dotnet_naming_rule.private_fields.style = underscore_camel
dotnet_naming_rule.private_fields.severity = warning
dotnet_naming_symbols.private_fields.applicable_kinds = field
dotnet_naming_symbols.private_fields.applicable_accessibilities = private
dotnet_naming_style.underscore_camel.capitalization = camel_case
dotnet_naming_style.underscore_camel.required_prefix = _

# prefer collection expressions over new List<T>() boilerplate
dotnet_style_prefer_collection_expression = when_types_loosely_match:suggestion

# missing XML docs only matter where you generate docs
dotnet_diagnostic.CS1591.severity = none
```

- **CS1591** (missing XML comment) pushes people to write empty docs. Disable it in application
  projects and keep `GenerateDocumentationFile` only for libraries you publish.
- **SA1124** (StyleCop: do not use regions) and **SA1123** (no regions inside elements) remove
  regions for good.
- **Roslynator** has refactorings and analyzers for converting loops to LINQ and simplifying
  collection code. Set up in CI as described in
  [Roslynator and analyzers in CI](/blog/2026-roslynator-and-analyzers-in-ci/), with
  `dotnet format` as in [consistent formatting locally and in CI](/blog/2026-consistent-formatting-locally-and-in-ci/).
- What tooling can't judge (is this comment useful?) belongs on your
  [code review checklist](/blog/2026-code-review-checklist/).

## Summary

- Noise isn't a bug, which is why it survives reviews. It still costs reading time on every visit.
- **Comments** explain why, not what. Fix names before writing comments, delete wrong ones and
  commented-out code.
- **Regions** around members are ceremony, and regions in large classes point to missing classes.
- **Prefixes** add noise and lie after refactorings. Use the .NET conventions and write names out.
- **`for i` with `List.Add`** in high-level code becomes `Select`, `Where` or `yield return`. Keep
  index loops for low-level code.
- Put the rules into `.editorconfig` and analyzers so nobody has to argue about them.
