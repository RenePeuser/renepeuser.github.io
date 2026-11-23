---
title: .NET 9 and OpenAPI — what broke, and how to fix it
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, aspnetcore, openapi]
excerpt: Swashbuckle gone from the templates, "Unable to render this definition", "No operations defined in spec" and transformers that stop compiling after the next upgrade. A practical guide to the built-in OpenAPI support since .NET 9, the usual errors and their real causes.
---

:::note[Series]
Part of the series [*REST & OpenAPI design*](/series/rest-and-openapi-design/).
:::

For years, OpenAPI in ASP.NET Core meant one thing: `AddSwaggerGen()`, `UseSwagger()`,
`UseSwaggerUI()`, done. With .NET 9, the templates dropped Swashbuckle and switched to the new
built-in package `Microsoft.AspNetCore.OpenApi`. Upgrading existing services, teams ran into a
handful of errors that look scary and are usually caused by a one-line mismatch.

This post collects the problems I keep seeing, the actual cause behind each, and how I set up
OpenAPI in new services today.

## What changed

| | Up to .NET 8 (template) | .NET 9 | .NET 10 |
|---|---|---|---|
| Generator | Swashbuckle | `Microsoft.AspNetCore.OpenApi` | `Microsoft.AspNetCore.OpenApi` |
| Default document URL | `/swagger/v1/swagger.json` | `/openapi/v1.json` | `/openapi/v1.json` |
| UI included | Swagger UI | none | none |
| Customization | `IDocumentFilter`, `IOperationFilter`, `ISchemaFilter` | document, operation and schema **transformers** | same, plus XML comment support |
| OpenAPI version | 3.0 | 3.0 | **3.1** by default |
| Object model | Microsoft.OpenApi 1.x | Microsoft.OpenApi 1.x | **Microsoft.OpenApi 2.x** |

Swashbuckle itself still exists and still works. Microsoft just doesn't ship it in the templates any
more. You can keep it, switch to the built-in generator, or mix (built-in generator plus Swagger UI or
Scalar as the viewer). What breaks is almost always a mix that doesn't fit together.

## The minimal setup

```csharp
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer<DocumentInfoTransformer>();
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

var app = builder.Build();

app.MapOpenApi();                                   // /openapi/v1.json
app.MapScalarApiReference();                        // UI at /scalar (package Scalar.AspNetCore)
// or, if you prefer Swagger UI (package Swashbuckle.AspNetCore.SwaggerUI only):
// app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));
```

That's it for the basics. Now to the errors.

## Problem 1: "Unable to render this definition"

Swagger UI shows this when the document it loads doesn't declare a valid `openapi` (3.x) or `swagger`
(2.0) version field at the top. The usual causes:

- **The UI points at the wrong URL.** After switching generators, `UseSwaggerUI()` still points at
  `/swagger/v1/swagger.json`, which no longer exists. The UI gets a 404 HTML page or an empty
  response, which of course has no version field. Point it at `/openapi/v1.json`.
- **Two generators at once.** `AddSwaggerGen()` and `AddOpenApi()` both registered, with the UI
  reading one and you editing the other. Pick one generator.
- **An old Swagger UI and OpenAPI 3.1.** .NET 10 emits 3.1 by default. Older Swagger UI versions
  can't render 3.1. Update the UI package, or set `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0`
  while you upgrade the consumers.

:::caution[Don't fake the version]
A workaround that circulates in some wikis adds `swagger: "2.0"` as an extension to an OpenAPI 3
document via a document filter. It makes the UI render, because the UI finds *a* version field.
But the document now claims to be two spec versions at once, and stricter tools (linters, client
generators, diff tools) will reject it or misread it. Fix the URL or the version mismatch instead.
:::

## Problem 2: "No operations defined in spec"

The document loads, the UI renders, and it's empty. With the built-in generator, the cause is
nearly always **document names versus group names**.

`AddOpenApi("v1")` creates a document called `v1`. By default it includes every endpoint whose
`GroupName` is either empty or equals `v1`. As soon as you use API versioning
(`Asp.Versioning`), or `WithGroupName("public")`, your endpoints get group names like `v1.0` or
`public`, and none of them match the document name.

Fix it by aligning the names, or by deciding explicitly:

```csharp
builder.Services.AddOpenApi("v1", o =>
{
    o.ShouldInclude = description =>
        description.GroupName is null or "v1" or "v1.0";
});
```

With `Asp.Versioning`, set `options.GroupNameFormat = "'v'V"` in `AddApiExplorer` so the group names
come out as `v1`, `v2`, matching `AddOpenApi("v1")` and `AddOpenApi("v2")`.

Controllers without `[ApiController]` or endpoints excluded with `ExcludeFromDescription()` don't
show up either. That's rarely the cause after an upgrade, but it's quick to check.

## Problem 3: transformers that don't compile after upgrading to .NET 10

You wrote a transformer in .NET 9 that adds an extension:

```csharp
using Microsoft.OpenApi.Any;   // gone in Microsoft.OpenApi 2.x

operation.Extensions["x-audience"] = new OpenApiString("internal");
```

.NET 10 moves to Microsoft.OpenApi 2.x, which removes the whole `Microsoft.OpenApi.Any` namespace.
`OpenApiString`, `OpenApiObject` and friends are replaced by `System.Text.Json.Nodes`:

```csharp
operation.Extensions ??= new Dictionary<string, IOpenApiExtension>();
operation.Extensions["x-audience"] = new JsonNodeExtension(JsonValue.Create("internal"));
```

Other changes you'll hit in the same upgrade:

- `OpenApiSchema.Type` is a flags enum (`JsonSchemaType.String | JsonSchemaType.Null`) instead of a
  string, and `Nullable` is gone, because 3.1 expresses null as a type.
- Many properties are interfaces now (`IOpenApiSchema`, `IOpenApiParameter`), and references are
  `OpenApiSchemaReference` objects instead of a `Reference` property.
- Collections can be `null`, so initialize before adding (`??=`).

Budget a few hours per custom transformer, and write a test that diffs the generated document before
and after (see below).

## Problem 4: no security scheme, no "Authorize" button

Swashbuckle had `AddSecurityDefinition`. The built-in generator has a document transformer:

```csharp
internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider schemes) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(OpenApiDocument document,
        OpenApiDocumentTransformerContext context, CancellationToken ct)
    {
        var all = await schemes.GetAllSchemesAsync();
        if (!all.Any(s => s.Name == JwtBearerDefaults.AuthenticationScheme))
            return;

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= [];
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = []
        });
    }
}
```

(That's the .NET 10 / Microsoft.OpenApi 2.x shape. In .NET 9 the scheme reference is an
`OpenApiSecurityScheme` with a `Reference` property instead.)

Applying the requirement globally is fine if every endpoint needs a token. If some are anonymous, add
it in an operation transformer instead, only for endpoints that have authorization metadata.

## Problem 5: schemas that look different

The built-in generator follows System.Text.Json more closely than Swashbuckle did. That's good, but
it changes the document, and a changed document can break generated clients:

- **Enums are integers** unless `JsonStringEnumConverter` is registered in the
  `ConfigureHttpJsonOptions` options. Swashbuckle often had its own setting for that. Register the
  converter once and the schema follows.
- **Numbers as `integer | string`.** The web defaults of System.Text.Json allow reading numbers from
  strings, and the generator documents exactly that, with a `pattern`. If you don't want clients to
  send `"42"`, set `NumberHandling = JsonNumberHandling.Strict`.
- **Duplicate schema names.** Two types called `Address` in different namespaces collide. Customize
  `options.CreateSchemaReferenceId` to produce unique IDs (for example, prefix with the containing
  type).
- **Nullable reference types.** `string?` versus `string` is reflected in the schema. If your
  annotations are sloppy, your document will be too.

## Problem 6: where did my XML comments go?

.NET 9's generator ignores XML doc comments. If your Swashbuckle setup used `IncludeXmlComments`,
summaries and descriptions disappear after the switch. .NET 10 brings them back through a source
generator. Enable `<GenerateDocumentationFile>true</GenerateDocumentationFile>`, and the summaries
show up without further code. On .NET 9, use `WithSummary`/`WithDescription` on minimal API endpoints,
or stay on Swashbuckle until you upgrade.

## Bonus: generate the document at build time

Serving `openapi.json` at runtime is convenient. Having it as a **file in the repository** is better:
reviewers see contract changes in the pull request, and tools can diff it. Add the
`Microsoft.Extensions.ApiDescription.Server` package:

```xml
<PropertyGroup>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)/../../contracts</OpenApiDocumentsDirectory>
  <OpenApiGenerateDocumentsOptions>--file-name orders-api</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

Every build now writes the document. That's the foundation for
[detecting breaking changes](/blog/2026-detecting-breaking-changes-with-openapi-diffs/).

Note that the build-time generation starts your app's entry point. Code that connects to a database
or Key Vault at startup will fail there; guard it, for example with
`Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider"`.

## Swashbuckle or built-in?

| | Swashbuckle | `Microsoft.AspNetCore.OpenApi` |
|---|---|---|
| Maintained by | community | Microsoft, ships with ASP.NET Core |
| Native AOT | ❌ | ✅ |
| OpenAPI 3.1 | recent versions | ✅ default in .NET 10 |
| XML comments | ✅ | .NET 10+ |
| Ecosystem of filters / samples | large | growing |
| Build-time document | via CLI tool | via `ApiDescription.Server` |

For new services on .NET 10, I use the built-in generator. For an existing service with a lot of
Swashbuckle filters, there's no rush. Migrate when you touch the OpenAPI setup anyway, and diff the
output.

## Should the document be public?

The templates map the document only in development. That's a sensible default, not a law. Ask who
consumes it: if an API gateway, a client generator in another repository or a partner needs it,
publish it deliberately (build-time file or an authenticated endpoint). If nobody does, don't expose
it in production. It's a complete map of your attack surface.

## Make it safe to upgrade

- **Snapshot test:** generate the document in an integration test
  (`GET /openapi/v1.json` on `WebApplicationFactory`) and compare it with the committed file. Any
  generator upgrade that changes the contract shows up as a failing test, not as a broken client
  three weeks later.
- **Lint it:** run Spectral or a similar linter in CI against the generated file. It catches missing
  operation IDs, missing descriptions and invalid documents before anyone tries to render them.

## Summary

- Since .NET 9, the templates use **`Microsoft.AspNetCore.OpenApi`**, served at `/openapi/{name}.json`,
  without a UI. Add Scalar or Swagger UI yourself.
- "Unable to render this definition" = the UI got **no valid version field**: wrong URL, two
  generators, or an old UI with OpenAPI 3.1. Don't fake the version.
- "No operations defined" = **document name vs. group name** mismatch. Align them or set
  `ShouldInclude`.
- .NET 10 moves to **Microsoft.OpenApi 2.x and OpenAPI 3.1**. Custom transformers need updating
  (`OpenApiString` → `JsonNode`).
- Security schemes, enum strings and unique schema IDs need **explicit configuration**.
- Generate the document **at build time** and snapshot-test it, so every upgrade is a visible diff.
