---
title: Security filters — rejecting what your API never asked for
date: 2026-11-23
authors: rene
tags: [dotnet, aspnetcore, security]
excerpt: ASP.NET Core silently ignores query parameters your endpoint doesn't declare. A small filter that rejects them turns scanner noise into a visible security signal. Why it's defense in depth and not injection protection, and how to build it for controllers and minimal APIs.
---


Send this to almost any ASP.NET Core API:

```http
GET /orders?status=open&debug=true&id=1%27%20OR%201=1--
```

If the endpoint only declares `status`, the framework binds `status`, ignores the rest and returns
`200 OK`. From the API's point of view nothing happened. From an attacker's point of view, they just
learned that the API accepts anything without complaint, and a vulnerability scanner can fire
thousands of variations without leaving a trace in your logs.

This post is about a small, deliberately strict filter: **reject requests that contain query
parameters the endpoint never declared.** It's one of the security filters I add to every API.

## Where this comes from

One API platform I worked on introduced exactly this filter back in 2020. It exposed many public
endpoints and went through regular penetration tests. The architecture review concluded that silently
accepting arbitrary input enlarged the observable attack surface and made automated scanning and
fuzzing hard to spot. The goals were:

- **Fail fast**, before model binding or any business code runs.
- **Enforce the contract**: only documented parameters are accepted.
- **Make probing visible**: every rejection is a structured security event.

When the team re-assessed it years later, the conclusion still held. ASP.NET Core still ignores
undeclared query parameters, and there's still no built-in switch to change that.

:::caution[This is not injection protection]
The filter doesn't protect you from SQL injection or XSS. Parameterized queries, output encoding and
input validation do that. A malicious value in a **declared** parameter passes this filter. It's a
defense-in-depth layer that reduces noise and raises a flag, nothing more. If someone on the team
thinks of it as "our SQL injection filter", correct that early.
:::

## Controllers: a resource filter

An `IActionFilter` runs **after** model binding. To reject before binding, use an
`IResourceFilter`, which runs earlier in the MVC pipeline:

```csharp
internal sealed class RejectUnknownQueryParametersFilter(ILogger<RejectUnknownQueryParametersFilter> logger)
    : IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var declared = DeclaredQueryParameters(context.ActionDescriptor);
        var unknown = context.HttpContext.Request.Query.Keys
            .Where(key => !declared.Contains(key))
            .ToArray();

        if (unknown.Length == 0)
            return;

        logger.UnknownQueryParameters(context.HttpContext.Request.Path, unknown);

        context.Result = new ObjectResult(new ProblemDetails
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "Unknown query parameters",
            Detail = $"This endpoint does not accept: {string.Join(", ", unknown)}"
        })
        { StatusCode = StatusCodes.Status400BadRequest };
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }

    private static HashSet<string> DeclaredQueryParameters(ActionDescriptor action)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var parameter in action.Parameters)
        {
            var source = parameter.BindingInfo?.BindingSource;
            if (source is not null && source != BindingSource.Query && source != BindingSource.ModelBinding)
                continue;   // route, body, header, services: not query

            if (IsSimple(parameter.ParameterType))
            {
                names.Add(parameter.BindingInfo?.BinderModelName ?? parameter.Name);
            }
            else if (source == BindingSource.Query)
            {
                // [FromQuery] SearchRequest request: its properties are the query parameters
                foreach (var property in parameter.ParameterType.GetProperties())
                    names.Add(property.GetCustomAttribute<FromQueryAttribute>()?.Name ?? property.Name);
            }
        }

        return names;
    }

    private static bool IsSimple(Type type)
    {
        type = Nullable.GetUnderlyingType(type) ?? type;
        return type.IsPrimitive || type.IsEnum || type == typeof(string) || type == typeof(Guid)
            || type == typeof(decimal) || type == typeof(DateTime) || type == typeof(DateTimeOffset)
            || type == typeof(DateOnly) || type.IsArray;
    }
}
```

The reflection runs per request here to keep the sample short. In a real implementation, cache the
set per `ActionDescriptor.Id` in a `ConcurrentDictionary`.

Registered globally:

```csharp
builder.Services.AddControllers(options => options.Filters.Add<RejectUnknownQueryParametersFilter>());
```

And a source-generated log method, so the security event has a stable event ID you can alert on:

```csharp
internal static partial class SecurityLog
{
    [LoggerMessage(EventId = 4001, Level = LogLevel.Warning,
        Message = "Rejected request to {Path} with unknown query parameters {Parameters}")]
    public static partial void UnknownQueryParameters(this ILogger logger, string path, string[] parameters);
}
```

Note what's logged: parameter **names**, not values. Values are attacker-controlled input. Logging
them verbatim invites log injection and fills your log store with payloads.

## Minimal APIs: metadata plus an endpoint filter

Minimal API endpoints don't have an `ActionDescriptor` with binding info that's convenient to read,
so I make the allowed parameters explicit as metadata. That's more honest anyway: the contract is
visible right at the endpoint.

```csharp
public sealed record AllowedQueryParameters(params string[] Names);

internal sealed class RejectUnknownQueryParametersEndpointFilter(ILogger<RejectUnknownQueryParametersEndpointFilter> logger)
    : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var allowed = http.GetEndpoint()?.Metadata.GetMetadata<AllowedQueryParameters>()?.Names ?? [];

        var unknown = http.Request.Query.Keys
            .Where(key => !allowed.Contains(key, StringComparer.OrdinalIgnoreCase))
            .ToArray();

        if (unknown.Length > 0)
        {
            logger.UnknownQueryParameters(http.Request.Path, unknown);
            return TypedResults.Problem(
                title: "Unknown query parameters",
                detail: $"This endpoint does not accept: {string.Join(", ", unknown)}",
                statusCode: StatusCodes.Status400BadRequest);
        }

        return await next(context);
    }
}
```

```csharp
var orders = app.MapGroup("/orders")
                .AddEndpointFilter<RejectUnknownQueryParametersEndpointFilter>();

orders.MapGet("/", SearchOrdersAsync)
      .WithMetadata(new AllowedQueryParameters("status", "page", "pageSize"));
```

Endpoint filters run after parameter binding, so this rejects slightly later than the resource filter.
If that matters to you, the same check works as a small middleware after `UseRouting()`, reading the
same metadata.

## Other filters worth having

The query filter is the specific one. A few more belong in the same "reject early" category, and most
are built in:

| Concern | Tool |
|---|---|
| Oversized bodies | `[RequestSizeLimit]` or Kestrel `MaxRequestBodySize` (30 MB default; lower it for JSON APIs) |
| Request flooding | `builder.Services.AddRateLimiter(...)` + `app.UseRateLimiter()` (.NET 7+) |
| Unknown JSON properties | `JsonUnmappedMemberHandling.Disallow` (.NET 8+), the body equivalent of this filter |
| Missing scope on an endpoint | Fallback policy plus a test, see the JWT post |
| Security headers | `X-Content-Type-Options: nosniff`, HSTS; small middleware or a package |

The JSON one is the natural twin of the query filter:

```csharp
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
```

Be careful with both on **public** APIs with many clients. Strictness is a contract decision: a client
that sends an extra field after an upgrade now gets a 400. For internal APIs with generated clients,
I turn both on. For public APIs, I discuss it first and version it.

## Pitfalls

**Breaking well-meaning clients.** Cache busters (`?_=1699999999`), tracking parameters
(`utm_source`) or an API gateway that appends its own parameter will all be rejected. Find out before
you go live, and allow-list known ones globally if needed.

**Forgetting `[FromQuery(Name = "...")]`.** A parameter bound under a different name than the C#
parameter must be compared under the bound name. The resource filter above handles
`BinderModelName` for that reason.

**Returning too much detail.** Echoing the unknown parameter names is fine. Echoing values or the full
query string isn't.

**Throwing instead of returning.** Throwing a security exception from the filter works with a global
exception handler (next posts), but returning a result is cheaper and doesn't produce an exception
log entry for every scanner request.

## How to test and monitor it

- An **integration test** per endpoint group: a request with `?unexpected=1` returns 400 with
  ProblemDetails, and a request with all declared parameters returns 200.
- A **code rule test** that every minimal API endpoint with query parameters has
  `AllowedQueryParameters` metadata, so the allow-list doesn't drift from the signature.
- An **alert** on event ID 4001: a spike usually means somebody is scanning you. That's exactly the
  signal you wanted when you built the filter.

## Summary

- ASP.NET Core **silently ignores** undeclared query parameters. That makes scanning invisible.
- A filter that **rejects unknown parameters** enforces the contract, fails fast and creates a
  security signal.
- It's **defense in depth**, not injection protection.
- Controllers: an **`IResourceFilter`**, which runs before model binding. Minimal APIs: explicit
  **metadata** plus an endpoint filter or middleware.
- Log parameter **names**, never values, with a stable **event ID** you can alert on.
- Strictness is a **contract decision**: great for internal APIs, discuss it for public ones.

*Previous: [CORS done right](/blog/2026-cors-done-right/) ·
Next: [Global error handling with ProblemDetails](/blog/2026-global-error-handling-with-problemdetails/)*
