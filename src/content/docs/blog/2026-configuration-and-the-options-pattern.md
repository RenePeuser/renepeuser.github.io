---
title: Configuration and the Options pattern — fail at startup, not at 3 a.m.
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, aspnetcore, configuration]
excerpt: Settings that are read with magic strings, validated nowhere and discovered missing on the first request that needs them. How configuration layering works, when to use IOptions, IOptionsSnapshot or IOptionsMonitor, and how ValidateOnStart turns typos into startup failures.
---

:::note[Series]
Part of the series [*ASP.NET Core from the ground up*](/series/aspnetcore-from-the-ground-up/).
:::

The worst configuration bug is the one that doesn't fail. A typo in an environment variable name, a
section that was renamed in `appsettings.json` but not in the pipeline, and the app starts happily
with an empty string as the base URL of a downstream service. The first customer who places an order
finds the bug for you.

This post is about getting configuration **into typed objects, validated at startup**, so that a
broken setting stops the deployment instead of a request.

## The "before": magic strings everywhere

```csharp
public sealed class InvoiceMailer(IConfiguration configuration)
{
    public Task SendAsync(Invoice invoice, CancellationToken ct)
    {
        var host = configuration["Mail:Host"];                     // null if missing
        var port = int.Parse(configuration["Mail:Port"] ?? "25");  // throws at runtime if "abc"
        // ...
    }
}
```

Three problems in two lines: the key is a string that the compiler can't check, there's no validation
until the code runs, and `IConfiguration` leaks into production code, so any class can read any
setting. A rule I've used in several teams: **`IConfiguration` is allowed in `Program.cs` and in
registration extensions, nowhere else.**

## How the layering works

Configuration in ASP.NET Core is a stack of providers. Each one is a flat dictionary of keys like
`Mail:Host`, and later providers override earlier ones. With `WebApplication.CreateBuilder`, the
order is `appsettings.json` → `appsettings.{Environment}.json` → user secrets (Development only) →
environment variables → command line.

That has a practical consequence: **the environment variables of your deployment are the source of
truth.** `appsettings.json` contains defaults and local development values. Anything a stage needs
has to be in the stage's environment (container definition, App Service settings, pipeline
variables). One team I worked with made this explicit per tenant and stage, so a value checked in
locally could never change what a stage actually runs with.

### Environment variable names

The hierarchy separator in keys is `:`. In environment variables, use a double underscore, because
`:` isn't allowed in variable names on Linux:

```text
Mail__Host=smtp.example.com
Mail__Port=587
Catalog__Endpoints__0__Name=primary
Catalog__Endpoints__0__Url=https://catalog.example.com/
```

Arrays are indexed with `__0__`, `__1__` and so on. That's the part people get wrong most often in
pipelines, and it's worth a line in your README.

## The Options pattern

A class per section, named like the section:

```csharp
public sealed class MailOptions
{
    public const string SectionName = "Mail";

    [Required]
    public string Host { get; init; } = string.Empty;

    [Range(1, 65535)]
    public int Port { get; init; } = 587;

    [Required, EmailAddress]
    public string Sender { get; init; } = string.Empty;

    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);
}
```

```json
{
  "Mail": {
    "Host": "localhost",
    "Port": 2525,
    "Sender": "shop@example.com"
  }
}
```

Registered in the feature's extension method:

```csharp
services.AddOptions<MailOptions>()
        .BindConfiguration(MailOptions.SectionName)
        .ValidateDataAnnotations()
        .ValidateOnStart();
```

- **`BindConfiguration`** binds the section by name, including later reloads.
- **`ValidateDataAnnotations`** checks the attributes when the options are first created.
- **`ValidateOnStart`** moves that first creation to host startup. Without it, validation happens
  on the first request that needs `MailOptions`, which is exactly what we want to avoid.

A broken setting now produces this at startup:

```
Microsoft.Extensions.Options.OptionsValidationException:
DataAnnotation validation failed for 'MailOptions' members: 'Host' with the error:
'The Host field is required.'
```

The deployment's health check never goes green, the old version keeps running, and you read the
error in the logs instead of in a support ticket.

### Rules that go beyond attributes

```csharp
services.AddOptions<MailOptions>()
        .BindConfiguration(MailOptions.SectionName)
        .ValidateDataAnnotations()
        .Validate(o => o.Port != 25 || o.Host == "localhost",
                  "Port 25 is only allowed against a local relay.")
        .ValidateOnStart();
```

For larger rule sets, implement `IValidateOptions<MailOptions>`. On .NET 8 and later, you can also
let a source generator write the validator (`[OptionsValidator]` on a `partial` class), which avoids
reflection and works with trimming and Native AOT.

## IOptions, IOptionsSnapshot, IOptionsMonitor

| | Lifetime | Sees changes | Use when |
|---|---|---|---|
| `IOptions<T>` | Singleton | ❌ value computed once | The default. Settings that don't change at runtime |
| `IOptionsSnapshot<T>` | Scoped | ✅ per request | Per-request consistency with reload support, in scoped services |
| `IOptionsMonitor<T>` | Singleton | ✅ `CurrentValue`, `OnChange` | Singletons that must react to reloads; named options |

Two traps:

- **`IOptionsSnapshot<T>` in a singleton** is a captive dependency. With `ValidateScopes` on, it
  throws. Use `IOptionsMonitor<T>` there.
- **Reloading only works if the provider reloads.** JSON files with `reloadOnChange` do. Environment
  variables don't change while the process runs. In a container, "hot reload of configuration" is
  usually a fiction unless you use something like Azure App Configuration with a refresh.

## The controversial part: should consumers see IOptions at all?

One team I worked with decided against injecting `IOptions<T>` into services. Their reasoning:

- `.Value` is noise in every consumer.
- They never used reloading, so the indirection bought nothing.
- Settings with placeholders (`"{tenant}/orders"`) had to be prepared somewhere, and it must not be
  the consumer's job.

They registered the settings object itself as a singleton. I think the instinct is right: **a
consumer should get settings that are ready to use.** But you don't have to give up validation for
it. You can have both:

```csharp
services.AddOptions<CatalogOptions>()
        .BindConfiguration(CatalogOptions.SectionName)
        .PostConfigure<IOptions<TenantOptions>>((catalog, tenant) =>
            catalog.BasePath = catalog.BasePath.Replace("{tenant}", tenant.Value.Name))
        .ValidateDataAnnotations()
        .ValidateOnStart();

// Expose the validated, prepared value directly
services.TryAddSingleton(sp => sp.GetRequiredService<IOptions<CatalogOptions>>().Value);
```

```csharp
internal sealed class CatalogClient(HttpClient http, CatalogOptions options) { /* ... */ }
```

`PostConfigure` does the placeholder replacement in one place, validation still runs at startup, and
consumers depend on a plain object. (For `PostConfigure` to assign, `BasePath` needs a setter instead
of `init`.) If you need reloading later, switch that one consumer to `IOptionsMonitor<T>`.

## Records and immutability

You'll still find wikis saying "the binder doesn't support records with primary constructors". That
was true years ago. Since .NET 7 the binder can bind through a constructor. I still prefer classes
or records with `init` properties for options, for two reasons: default values are easy to express
per property, and data annotations work without the `[property: Required]` dance that positional
parameters need.

What I avoid: **nullable properties as a substitute for "optional"**. A `string?` that the app can't
work without is a validation rule you didn't write. Give optional settings a sensible default
instead, so the app still runs if the setting is missing, and make required ones `[Required]`.

## Pitfalls

**The class name doesn't match the section.** Binding a section that doesn't exist doesn't fail. It
produces an object full of defaults. `ValidateOnStart` with `[Required]` is what catches that.

**Reading options during registration.** `configuration.GetSection("Mail").Get<MailOptions>()` inside
`AddX` is sometimes necessary (to decide *whether* to register something). Then validate it right
there, because the options pipeline won't.

**Secrets in `appsettings.json`.** Covered in the next post. Short version: never.

**Binding without the source generator in AOT apps.** For Native AOT, set
`<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` so binding doesn't
rely on reflection.

## How to enforce it

- A **startup smoke test** with `WebApplicationFactory<Program>` and the test configuration catches
  every `ValidateOnStart` failure in CI.
- A **banned API rule** (`Microsoft.CodeAnalysis.BannedApiAnalyzers`) for `IConfiguration` in
  feature namespaces, or an architecture test, keeps magic strings out of services.
- **A test per environment** that loads `appsettings.json` plus the stage's variable set and
  validates all options. That catches the renamed section before the pipeline does.

## Summary

- **Environment variables are the source of truth**, `appsettings.json` holds defaults. Use
  `Section__Key` and `__0__` for arrays.
- One **options class per section**, named like the section, with **data annotations**.
- **`ValidateOnStart`** turns a broken setting into a failed deployment instead of a failed request.
- `IOptions<T>` by default, **`IOptionsMonitor<T>`** in singletons that need reloads, never
  `IOptionsSnapshot<T>` in a singleton.
- Consumers should get **ready-to-use settings**. `PostConfigure` plus registering `.Value` gives you
  that without losing validation.
- Keep **`IConfiguration` out of production code**.

*Previous: [Service registration and DI lifetimes](/blog/2026-di-lifetimes-and-service-registration/) ·
Next: [User secrets and client secrets](/blog/2026-user-secrets-and-client-secrets/)*
