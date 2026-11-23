---
title: Take nullability warnings seriously
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, csharp, code-quality, pitfalls]
excerpt: Nullable reference types only help if the warnings mean something. How a codebase ends up with hundreds of CS8602 warnings and a "!" on every other line, the design decision that removes most null checks, and how to get from warnings to a build that refuses nulls where they don't belong.
---

:::note[Series]
Part of the series [*.NET pitfalls*](/series/dotnet-pitfalls/).
:::

Nullable reference types have been around since C# 8, and every new project template turns them on.
Still, when I open an existing solution, I usually find one of two states:

1. `<Nullable>enable</Nullable>` is set, the build shows a few hundred CS8602/CS8618 warnings, and
   nobody looks at them any more.
2. The warnings are "fixed", which means there's a `!` behind every second expression.

Both are worse than not enabling the feature at all, because the annotations now **lie**. A `string`
that can be `null` and a `Customer` that's never checked look exactly like the safe ones.

## What the feature is (and isn't)

Nullable reference types are a **compile-time** analysis. `string` means "this should never be null",
`string?` means "this may be null, check it". The compiler tracks the null state through your code and
warns when you dereference something that might be null (CS8602), assign a maybe-null to a non-nullable
(CS8600/CS8601), or leave a non-nullable property uninitialized (CS8618).

At runtime nothing changes. A `string` property can still be `null` if a deserializer, a mapper,
reflection or an old library puts one there. That's important for everything that follows: **the
annotations describe your intent; your boundaries have to enforce it.**

## Where the warnings come from: a design question

Most nullability noise isn't caused by the compiler. It's caused by APIs that return `null` for
everything that "didn't work":

```csharp
public async Task<Order?> GetOrderAsync(OrderNumber number, CancellationToken ct) { /* ... */ }

// every caller, everywhere:
var order = await orders.GetOrderAsync(number, ct);
if (order is null)
{
    throw new InvalidOperationException($"Order {number} not found");   // the same 4 lines, 40 times
}
```

The question to ask for each such method is: **is "not found" a normal outcome for the caller, or is
it an error?**

In one codebase I worked on, the team made exactly that a rule: before you write a method, decide
whether handling `null` is actually needed. If it is, make it nullable and handle it. If it isn't,
throw as soon as an object isn't in the expected state, and stop passing `null` around. For queries,
they introduced pairs with a naming convention:

```csharp
/// <summary>Gets the order. Throws <see cref="NotFoundException"/> if it doesn't exist.</summary>
public sealed record GetOrderByNumber(OrderNumber Number) : IQuery<Order>;

/// <summary>Gets the order, or <c>null</c> if it doesn't exist.</summary>
public sealed record GetOrderByNumberOrDefault(OrderNumber Number) : IQuery<Order?>;
```

That's the same idea as `First` vs. `FirstOrDefault` in LINQ, and it works remarkably well:

- The **name** tells you whether `null` is possible.
- The **type** says the same, so the compiler agrees with the name.
- Callers that expect the order to exist (the majority) get a non-nullable `Order` and no null checks.
- The exception is thrown in one place, with a consistent message, and your error-handling middleware
  can map `NotFoundException` to a `404` problem details response.

The third common variant is the `Try` pattern, which is the right choice when "not found" is frequent and
an exception would be too expensive:

```csharp
public bool TryGetCachedPrice(ProductId id, [NotNullWhen(true)] out Money? price) { /* ... */ }

if (prices.TryGetCachedPrice(id, out var price))
{
    total += price.Amount;   // no warning: the compiler knows price isn't null here
}
```

## The attributes that make the compiler smarter

When the flow analysis can't see what you know, tell it instead of using `!`:

| Attribute | Meaning | Typical use |
|---|---|---|
| `[NotNullWhen(true)]` | Out parameter isn't null if the method returns `true` | `TryGet...` methods |
| `[MaybeNullWhen(false)]` | Out parameter may be null if the method returns `false` | Generic `TryGet` with unconstrained `T` |
| `[NotNull]` | The argument isn't null after the call returns | Guard methods |
| `[MemberNotNull(nameof(_x))]` | Field is initialized after this method | `Initialize()` helpers called from constructors |
| `[DoesNotReturn]` | Method never returns (always throws) | `ThrowHelper` methods |
| `[NotNullIfNotNull(nameof(input))]` | Return value isn't null if the argument isn't | Mapping and conversion helpers |

Guard methods from the BCL already carry these attributes, so after them the compiler knows the value
is safe:

```csharp
public sealed class InvoiceService(IInvoiceRepository repository)
{
    public async Task SendAsync(Invoice invoice, string recipient, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(invoice);
        ArgumentException.ThrowIfNullOrWhiteSpace(recipient);
        // ...
    }
}
```

## The `!` operator is a comment that the compiler believes

`order!.Total` tells the compiler "trust me". It removes the warning, adds no check, and the next
refactoring can make the assumption false without anyone noticing. There are legitimate uses:

- Test code, where a `NullReferenceException` is a perfectly good failure.
- Code the flow analysis provably can't follow, with a comment explaining why.
- `default!` for properties that a framework sets right after construction, though `required` is
  usually the better tool now.

Everywhere else, a `!` is a design smell: either the type should be nullable, or the API shouldn't
return null in the first place. I treat a new `!` in production code like a `#pragma warning disable`:
it needs a reason in the review.

## `required` instead of `= null!`

CS8618 on DTOs and options classes used to be "fixed" with `= null!` or `= default!`. Since C# 11 there's
a better answer:

```csharp
public sealed class CreateCustomerRequest
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public string? VatId { get; init; }
}
```

`required` forces every object initializer to set the property, so the non-nullable annotation is true
for everything constructed in code. Records with primary constructors achieve the same thing.

## The boundaries: JSON, databases, configuration

Because the analysis is compile-time only, data that enters from outside needs its own check.

**JSON.** By default, `System.Text.Json` happily writes `null` into a non-nullable `string`. Since
.NET 9 you can make it respect the annotations:

```csharp
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.RespectNullableAnnotations = true;            // null into string → JsonException
    options.SerializerOptions.RespectRequiredConstructorParameters = true;  // missing ctor parameter → JsonException
});
```

Now a request body with `"name": null` fails deserialization instead of creating an object whose type
lies. A validator (FluentValidation, DataAnnotations or the built-in minimal API validation in .NET 10)
covers the rest: empty strings, formats, ranges.

**EF Core.** With nullable reference types enabled, EF Core uses the annotations for column
nullability: `string` becomes `NOT NULL`, `string?` becomes nullable. Turning the feature on in an
existing model can therefore produce a migration that changes columns. Review it before you apply it.

**Configuration.** Options classes bound from `appsettings.json` have the same problem as JSON. Use
`ValidateDataAnnotations()` and `ValidateOnStart()`, so a missing setting fails at startup rather than
at the first request.

## Getting an existing codebase there

Enabling the feature on a large legacy solution at once produces a wall of warnings, and walls of
warnings get ignored. What has worked for me:

1. **Enable it for new projects immediately**, with warnings as errors from day one.
2. For existing projects, start with **`<Nullable>warnings</Nullable>`** or file-level `#nullable enable`,
   beginning with the leaf projects (domain, shared contracts) that everything else depends on.
3. **Fix the APIs, not the call sites.** Decide `Get` vs. `GetOrDefault` for the methods that cause the
   most warnings. One signature change often removes dozens of warnings downstream.
4. **Ratchet.** Once a project is clean, make the nullable warnings errors for that project so it stays
   clean.

```xml
<PropertyGroup>
  <Nullable>enable</Nullable>
  <WarningsAsErrors>$(WarningsAsErrors);nullable</WarningsAsErrors>
</PropertyGroup>
```

`nullable` is a shortcut that covers all nullable-related warnings. That single line is the difference
between "we have nullable reference types" and "our types tell the truth".

## Summary

- Nullable reference types are a **compile-time contract**. Unread warnings and `!` everywhere make the
  contract worthless.
- Most null checks disappear with one design decision: **throw when "not found" is an error**, return
  `null` only when it's a normal outcome, and make the difference visible in the name (`Get` vs.
  `GetOrDefault`, `Try...`).
- Use the **nullable attributes** and BCL guard methods instead of `!`.
- Use **`required`** instead of `= null!`.
- Enforce at the **boundaries**: `RespectNullableAnnotations` for JSON, validated options, and careful
  EF Core migrations.
- Migrate **project by project** and lock each one in with `WarningsAsErrors` for `nullable`.
