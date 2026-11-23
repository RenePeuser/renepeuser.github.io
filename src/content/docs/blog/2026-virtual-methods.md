---
title: Virtual methods — sealed by default, base by default
date: 2026-11-23
authors: rene
tags: [dotnet, csharp, api-design, performance]
excerpt: Every virtual method is a promise you'll have to keep, and every override that skips base is a behaviour change, whether anyone meant it or not. Why I seal classes by default, when a virtual method is the right extension point, and the review rule for overrides.
---


`virtual` is one keyword, and it's easy to add "just in case". Someone might want to override this
later, right? And when you override a method, leaving out the `base` call looks like a harmless
simplification.

Both are design decisions with consequences. A `virtual` method is a public contract with every
future subclass. An override without `base` silently replaces behaviour that the base class, and
everyone who uses it, relies on. This post covers both sides: when to make something virtual at all,
and how to override safely when you have to.

## Part 1: sealed by default

In C#, classes are open for inheritance unless you say otherwise. Methods are closed unless you say
`virtual`. I'd go one step further than the language: **classes are `sealed` unless there's a reason
not to.**

```csharp
public sealed class InvoiceNumberGenerator(TimeProvider clock, IInvoiceSequence sequence)
{
    public async Task<InvoiceNumber> NextAsync(CancellationToken ct)
    {
        var next = await sequence.NextAsync(ct);
        return new InvoiceNumber($"INV-{clock.GetUtcNow():yyyy}-{next:D6}");
    }
}
```

Why seal?

**Design.** An unsealed class has two kinds of users: those who call it and those who inherit from it.
The second group can see your protected members, depends on the order in which your methods call each
other, and breaks when you refactor internals. That's the *fragile base class* problem. Sealing keeps
the contract small: the public API is all there is. If someone needs different behaviour, they compose
(wrap it, or depend on an interface) instead of inheriting.

**Performance.** For sealed types, the JIT knows there can't be an override, so it can turn virtual and
interface calls into direct calls and inline them. Type checks (`is`, `as`, casts) against a sealed type
are a simple pointer comparison instead of a walk up the hierarchy. Dynamic PGO, on by default since
.NET 8, recovers part of that difference for unsealed types with *guarded devirtualization*, but a
guard is still more work than knowing for sure. In most business code you won't measure the difference.
In hot paths, serializers or parsers you will. And sealing is free.

**Tooling agrees.** Since .NET 7, analyzer **CA1852** reports internal types that could be sealed
because nothing derives from them. The code fix seals them for you.

Unsealing later is a non-breaking change. Sealing later is a breaking change. So start sealed.

### Not a reason for virtual: mocking

The most common reason I find for `virtual` in application code is a mocking library that needs to
override members:

```csharp
public class PriceCalculator                      // unsealed only so Moq can subclass it
{
    public virtual Money Calculate(Order order) { /* ... */ }
}
```

That's the test design leaking into the production design. If a dependency needs to be replaced in tests,
give it an interface. If it's pure logic, don't mock it at all: use the real thing in the test.

## When virtual is the right tool

There are good reasons to design for inheritance: framework base classes, plug-in points, and the
*template method* pattern, where the base class owns the algorithm and the derived class fills in steps.

If you do, design the extension points instead of making everything overridable:

```csharp
public abstract class ImportJob<TRow>
{
    public async Task<ImportSummary> RunAsync(Stream input, CancellationToken ct)   // not virtual: owns the flow
    {
        var summary = new ImportSummary();

        await foreach (var row in ReadRowsAsync(input, ct))
        {
            if (!Validate(row, summary))
                continue;

            await ImportRowAsync(row, ct);
            summary.Imported++;
        }

        await OnCompletedAsync(summary, ct);
        return summary;
    }

    protected abstract IAsyncEnumerable<TRow> ReadRowsAsync(Stream input, CancellationToken ct);   // must implement
    protected abstract Task ImportRowAsync(TRow row, CancellationToken ct);                       // must implement

    protected virtual bool Validate(TRow row, ImportSummary summary) => true;                      // optional hook

    protected virtual Task OnCompletedAsync(ImportSummary summary, CancellationToken ct) =>         // optional hook
        Task.CompletedTask;
}
```

The rules behind this shape:

- The **public method isn't virtual**. It owns the sequence of steps, so a derived class can't break it.
- Required steps are **`abstract`**. No empty default that someone forgets to override.
- Optional steps are **`protected virtual`** hooks with a trivial default, so overriding them without
  `base` is safe by design.
- Hooks are **named for when they run** (`OnCompleted`), not for what someone might do in them.

Two classic traps when designing for inheritance:

**Virtual calls in constructors.** If a base class constructor calls a virtual method, the override runs
before the derived class's constructor has initialized its fields. Analyzer **CA2214** warns about it.
Don't do it.

**Records.** Record classes generate virtual members (`Equals`, `PrintMembers`, `EqualityContract`) to
support inheritance between records. If you don't need record inheritance, write `sealed record`.

## Part 2: when you override, call base by default

Now the other side: you're deriving from a class someone else wrote, often a framework or SDK type.

```csharp
// ✅ extending: base logic still runs, then ours
protected override async Task InitializeAsync()
{
    await base.InitializeAsync();
    await WarmUpCacheAsync();
}

// ❌ replacing, probably by accident
protected override async Task InitializeAsync()
{
    await WarmUpCacheAsync();
}
```

The second version looks tidier. It also means that whatever the base class did in `InitializeAsync`
doesn't happen any more: setting up state, registering handlers, validating configuration, raising an
event. And if the next version of the framework adds something important to that method, your override
silently cuts that off too.

In one codebase I worked on, this became an explicit team standard, and I think it's the right one:

| Situation | Base call |
|---|---|
| **Extending** existing behaviour (the default assumption) | ✅ Call `base` |
| **Replacing** behaviour, intentionally and with the base logic understood | ❌ No `base`, **and a comment explaining why** |
| Base class from a framework, SDK or third-party library | ✅ Treat `base` as mandatory unless documented otherwise |

The real question in a review isn't "was `base` called?". It's: **is the contract of the base type
still intact?** If code that works with the base type would now behave differently, the derived type
is no longer a valid substitute. That's the Liskov substitution principle, and missing `base` calls are
the most common way to violate it without noticing.

An intentional replacement looks like this:

```csharp
// Intentionally not calling base: the base class validates against the v1 schema,
// this importer uses the v2 schema with a different validation model.
protected override bool Validate(ProductRow row, ImportSummary summary) =>
    _schemaV2Validator.Validate(row, summary);
```

Anyone who touches that code later knows it was a decision, not an oversight.

**Where does `base` go?** Usually first for initialization ("let the base set up, then add mine") and
last for cleanup (`Dispose(bool)`: release your own resources, then call `base.Dispose(disposing)`). If
the framework documentation says something specific, follow it.

### Review checklist for overrides

- Does this override **extend** or **replace**?
- Does the base implementation do anything important: initialization, validation, events, state
  transitions, pipeline steps?
- Is it a framework or third-party class whose base implementation may change in future versions?
- If `base` is skipped, is the reason written down next to the code?

## Overview

| Choice | Use when | Avoid when |
|---|---|---|
| `sealed class` | Default for all concrete classes | You're deliberately designing a base class |
| Interface + composition | Replaceable behaviour, test doubles, multiple implementations | A single implementation with no variation |
| `abstract` member | A step every derived class must provide | A sensible default exists |
| `protected virtual` hook with empty default | An optional step in an algorithm the base owns | It's only there "just in case" |
| `public virtual` method | Rarely; you're giving away control of the whole operation | Almost always |

## Enforce it

- **CA1852** (seal internal types), **CA2214** (no virtual calls in constructors). Set both to `warning`
  or higher.
- An architecture test for public types, which CA1852 doesn't cover, for example with NetArchTest:

```csharp
[TestMethod]
public void Concrete_classes_are_sealed()
{
    var result = Types.InAssembly(typeof(InvoiceNumberGenerator).Assembly)
        .That().AreClasses().And().AreNotAbstract()   // static classes are abstract in IL, so they're excluded
        .Should().BeSealed()
        .GetResult();

    Assert.IsTrue(result.IsSuccessful,
        $"Seal these classes or document why not: {string.Join(", ", result.FailingTypeNames ?? [])}");
}
```

- Missing `base` calls are hard to detect generically, because "replace" is sometimes correct. A review
  rule plus the mandatory comment for intentional replacements is what works in practice. For your own
  base classes, the template method shape above makes the question disappear: required logic lives in
  the non-virtual method, so there's nothing to forget.

## Summary

- **Seal classes by default.** It keeps the contract small, helps the JIT, and unsealing later is
  non-breaking.
- Don't make things **virtual for mocking**. Use interfaces, or don't mock pure logic.
- When designing for inheritance, use a **non-virtual public method**, **abstract** required steps and
  **protected virtual hooks** with trivial defaults. No virtual calls in constructors.
- When overriding, **call `base` by default**. Skipping it is a behaviour change and needs a comment that
  explains why.
- In reviews, ask whether the **base type's contract is still intact**, not just whether `base` was called.
