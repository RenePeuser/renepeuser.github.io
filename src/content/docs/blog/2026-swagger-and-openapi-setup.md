---
title: Setting up Swagger / OpenAPI — Microsoft.AspNetCore.OpenApi or Swashbuckle?
date: 2026-11-23
authors: rene
tags: [dotnet, aspnetcore, openapi, api-design]
excerpt: Since .NET 9 the templates no longer ship Swashbuckle, and upgraded projects suddenly render "Unable to render this definition". What changed, how to set up the built-in OpenAPI generator with versioning, security and per-stage metadata, and when Swashbuckle is still the better fit.
---


For years, "add Swagger" meant three lines: `AddSwaggerGen()`, `UseSwagger()`, `UseSwaggerUI()`.
Then .NET 9 removed Swashbuckle from the Web API template, and a lot of teams found out during an
upgrade. Swagger UI showed "Unable to render this definition" or "No operations defined in spec",
and the quick fixes that circulated patched the document version by hand, which makes the UI happy
and the tooling sad.

This post explains what changed, how I set up OpenAPI on .NET 9 and 10 today, and when Swashbuckle
is still the right tool.

## What changed

Three things are often mixed up:

- **OpenAPI** is the specification: a JSON/YAML document describing your API.
- **Swashbuckle** is a third-party library that *generates* that document from your code and ships
  **Swagger UI**, a page to browse it.
- **Microsoft.AspNetCore.OpenApi** is Microsoft's own generator, built into ASP.NET Core since .NET 9.

Starting with .NET 9, the templates use the built-in generator and ship **no UI**. Swashbuckle still
exists and is maintained, but it's no longer the default. On .NET 10, the built-in generator produces
**OpenAPI 3.1** by default and is based on version 2 of the `Microsoft.OpenApi` library, which has
breaking API changes for anyone who wrote document or schema filters.

If your upgraded project renders an empty or broken document, the cause is almost always a version
mismatch between Swashbuckle, `Microsoft.OpenApi` and the target framework. The fix is to update
Swashbuckle to a version that supports your .NET version, not to patch the `swagger` field in the
document.

## The built-in setup

```bash
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Scalar.AspNetCore    # optional UI
```

```csharp
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer<ApiInfoTransformer>();
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

var app = builder.Build();

app.MapOpenApi();                    // /openapi/v1.json
app.MapScalarApiReference();         // /scalar/v1, interactive UI
```

That's a working document. Endpoints show up with their routes, parameters and the types from
`TypedResults` or `[ProducesResponseType]`.

### Metadata per stage from configuration

The title, description and contact details belong in configuration. One team I worked with had an
API guideline that required them per version, and the values differed between internal and partner
stages:

```csharp
public sealed class ApiInfoOptions
{
    public const string SectionName = "ApiInfo";

    [Required] public string Title { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string ContactName { get; init; } = string.Empty;
    public string ContactUrl { get; init; } = string.Empty;
}

internal sealed class ApiInfoTransformer(IOptions<ApiInfoOptions> options) : IOpenApiDocumentTransformer
{
    public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken ct)
    {
        var info = options.Value;
        document.Info.Title = $"{info.Title} {context.DocumentName}";
        document.Info.Description = info.Description;
        document.Info.Contact = new OpenApiContact
        {
            Name = info.ContactName,
            Url = string.IsNullOrEmpty(info.ContactUrl) ? null : new Uri(info.ContactUrl)
        };
        return Task.CompletedTask;
    }
}
```

Transformers are resolved from DI, so they can take options and services like any other class.

### Bearer authentication in the document

```csharp
internal sealed class BearerSecuritySchemeTransformer(IAuthenticationSchemeProvider schemes)
    : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken ct)
    {
        if (!(await schemes.GetAllSchemesAsync()).Any(s => s.Name == JwtBearerDefaults.AuthenticationScheme))
            return;

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT"
        };
    }
}
```

The exact types (`IOpenApiSecurityScheme`, nullable collections) are the `Microsoft.OpenApi` 2.x
shapes used on .NET 10. On .NET 9 the collections are non-nullable classes. That's the kind of churn
that makes me keep transformers small.

### Versions

With `Asp.Versioning.Http` (or `.Mvc`), register one document per version and let the versioning
library's API explorer group endpoints:

```csharp
builder.Services.AddApiVersioning().AddApiExplorer(o => o.GroupNameFormat = "'v'V");

builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");
```

Each document only contains endpoints whose group name matches. If an endpoint shows up in no
document, check its group name first.

## XML comments

Summaries and descriptions from `///` comments make the document worth reading. Turn on the
documentation file:

```xml
<PropertyGroup>
  <GenerateDocumentationFile>true</GenerateDocumentationFile>
  <NoWarn>$(NoWarn);1591</NoWarn>
</PropertyGroup>
```

On .NET 10, the built-in generator picks up XML comments automatically through a source generator.
With Swashbuckle, you call `IncludeXmlComments(...)`. For minimal APIs, `.WithSummary()` and
`.WithDescription()` on the endpoint do the same job without XML.

## Should the document be public in production?

My default: **the JSON document yes, if the API has external consumers; the UI no.**

```csharp
app.MapOpenApi().AllowAnonymous().CacheOutput();

if (app.Environment.IsDevelopment())
{
    app.MapScalarApiReference();
}
```

A published contract is what client generators, API gateways and consumer teams need. An
interactive UI in production is mostly a convenience for attackers. If the API is internal only, it
can stay behind authentication. Make it a deliberate decision rather than whatever the template did.

Even better for many teams: generate the document **at build time** with
`Microsoft.Extensions.ApiDescription.Server` and commit it. Then a pull request shows contract
changes as a diff, and a breaking change is visible before it ships.

## Built-in vs. Swashbuckle vs. NSwag

| | Microsoft.AspNetCore.OpenApi | Swashbuckle | NSwag |
|---|---|---|---|
| Ships with the framework | ✅ | ❌ | ❌ |
| Native AOT support | ✅ | ❌ | ❌ |
| Bundled UI | ❌ (add Scalar or Swagger UI) | ✅ Swagger UI | ✅ |
| Customization | Document/operation/schema transformers | Filters, very mature | Processors |
| Ecosystem of existing filters and examples | Growing | Huge | Medium |
| Client generation | ❌ (use Kiota, NSwag, ...) | ❌ | ✅ built in |

For **new projects**, I use the built-in generator. For an **existing project** with a pile of
Swashbuckle filters that work, there's no urgent reason to migrate. Update Swashbuckle to a version
that supports your framework, and plan the migration when you touch the filters anyway.

## Pitfalls

**Undocumented error responses.** If endpoints only declare their 200, generated clients don't know
that a 404 returns ProblemDetails. Declare error types, ideally once per group:
`.ProducesProblem(StatusCodes.Status404NotFound)`.

**Anonymous types and `IResult`.** An endpoint returning `Results.Ok(new { ... })` produces an empty
schema. Use `TypedResults` and named response records.

**Copying configuration blocks everywhere.** One team I worked with packaged their whole Swagger
setup in a shared library because versioning, base paths and security made the "three lines" turn
into a hundred. That's reasonable, as long as the package stays thin. A shared OpenAPI setup is
exactly the kind of thing that breaks on framework upgrades, so keep it easy to update.

**Arrays from environment variables.** Per-version metadata as arrays needs
`ApiInfo__Versions__0__Title` style keys, as covered in the configuration post.

## How to enforce it

- A **test that fetches `/openapi/v1.json`** and asserts it parses and contains every endpoint. That
  catches the "empty document after upgrade" problem in CI.
- A **committed, build-time document** plus a breaking-change check (for example `oasdiff`) in the
  pipeline.
- A **code rule** that every endpoint declares its success and error responses.

## Summary

- **.NET 9+** ships Microsoft's own OpenAPI generator and **no UI**. Swashbuckle is optional, not
  gone.
- Broken documents after an upgrade are usually **version mismatches**. Update, don't patch.
- Configure **metadata per stage** and **bearer security** with document transformers that take
  options from DI.
- Publish the **JSON document** if you have consumers, keep the **UI** out of production, and
  consider generating the document **at build time**.
- New project: **built-in**. Existing Swashbuckle setup that works: **update it**, migrate later.

*Previous: [Error logging](/blog/2026-error-logging/) ·
Next: [A health endpoint that tells the truth](/blog/2026-a-health-endpoint-that-tells-the-truth/)*
