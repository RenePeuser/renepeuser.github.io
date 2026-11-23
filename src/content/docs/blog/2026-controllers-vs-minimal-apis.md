---
title: Controllers vs. minimal APIs — it's about structure, not syntax
date: 2026-11-23
authors: rene
tags: [dotnet, aspnetcore, minimal-apis, architecture]
excerpt: Minimal APIs were rejected as "unmaintainable for large projects", and later a similar team built their whole endpoint structure on them. What actually differs between controllers and minimal APIs in 2026, and the per-feature structure that makes either one scale.
---

:::note[Series]
Part of the series [*ASP.NET Core from the ground up*](/series/aspnetcore-from-the-ground-up/).
:::

When minimal APIs came out with .NET 6, a backend guideline I worked with contained a clear
decision: *we will not use minimal APIs, because they don't scale to large projects.
`Program.cs` would grow into an unreadable registration monster.* Given the demos at the time, a
whole API in one file full of lambdas, that was a fair conclusion.

A few years later, the guidelines of a similar backend landscape described a minimal API structure
in detail: domain, version, action, one endpoint per file, each registering itself. Same concern
about maintainability, opposite conclusion. What changed wasn't the team's values. It was the
realization that **the problem was never the syntax, it was the structure.**

## The same endpoint, twice

A controller:

```csharp
[ApiController]
[ApiVersion("1.0")]
[Route("v{version:apiVersion}/orders")]
[Authorize]
public sealed class OrdersController(ISender mediator) : ControllerBase
{
    [HttpGet("{id:int}")]
    [Authorize(Policy = Scopes.OrdersRead)]
    [ProducesResponseType<OrderResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public Task<OrderResponse> GetOrderAsync(int id, CancellationToken ct) =>
        mediator.Send(new GetOrder(id), ct);
}
```

A minimal API endpoint:

```csharp
internal static class GetOrderEndpoint
{
    public static RouteHandlerBuilder MapGetOrder(this IEndpointRouteBuilder orders) =>
        orders.MapGet("/{id:int}", HandleAsync)
              .RequireAuthorization(Scopes.OrdersRead)
              .WithName("getOrderV1")
              .ProducesProblem(StatusCodes.Status404NotFound);

    private static async Task<Ok<OrderResponse>> HandleAsync(int id, GetOrderQuery query, CancellationToken ct) =>
        TypedResults.Ok(await query.ExecuteAsync(id, ct));
}
```

Both are short. Both delegate to something that does the work. The differences are in the details
around them.

## What actually differs in 2026

| | Controllers | Minimal APIs |
|---|---|---|
| Grouping | Class per resource, attribute routing | Route groups (`MapGroup`), explicit |
| Dependencies | Constructor, shared by all actions | Per handler parameter, only what this endpoint needs |
| Filters | Action, resource, result, exception filters | Endpoint filters (simpler, fewer stages) |
| Model validation | `[ApiController]` automatic 400 | .NET 10: `AddValidation()`; before: manual or a library |
| Response types in OpenAPI | `[ProducesResponseType]` attributes | Inferred from `TypedResults` + `Produces*` |
| Model binding extensibility | Very rich (custom binders, value providers) | `BindAsync`/`TryParse` conventions; less, but enough for most |
| Native AOT | ❌ | ✅ with the request delegate generator |
| Startup and per-request overhead | Higher | Lower |
| OData, some older libraries | ✅ | Partly |

The two points that matter most in my experience:

**Dependencies per endpoint.** A controller with ten actions gets the union of every action's
dependencies in its constructor. A minimal API handler declares exactly what it needs. That makes
it obvious when one endpoint suddenly needs six services.

**Return types.** `Task<Results<Ok<OrderResponse>, NotFound<ProblemDetails>>>` is verbose, but the
compiler and the OpenAPI generator both know every possible response. With controllers, the
`[ProducesResponseType]` attributes can lie, and nothing checks them.

## The structure that makes it scale

The "registration monster" fear is real if all endpoints live in `Program.cs`. The fix is the same
per-feature structure from the DI post, applied to endpoints:

```text
Orders/
  OrdersModule.cs            AddOrders() + MapOrders()
  V1/
    GetOrder/
      GetOrderEndpoint.cs    MapGetOrder()
      GetOrderQuery.cs       + AddGetOrder()
    PlaceOrder/
      PlaceOrderEndpoint.cs
      PlaceOrderHandler.cs
      PlaceOrderRequest.cs
```

```csharp
public static class OrdersModule
{
    public static IServiceCollection AddOrders(this IServiceCollection services) =>
        services.AddGetOrder()
                .AddPlaceOrder();

    public static IEndpointRouteBuilder MapOrders(this IEndpointRouteBuilder app)
    {
        var v1 = app.MapGroup("/v1/orders")
                    .WithTags("Orders")
                    .RequireAuthorization();

        v1.MapGetOrder();
        v1.MapPlaceOrder();

        return app;
    }
}
```

`Program.cs` stays a table of contents (`AddOrders()`, `MapOrders()`), each action lives in its own
folder with everything it needs, and deleting a feature is deleting a folder plus two lines.

### Going one step further: self-registering endpoints

The later guidelines I mentioned went further: every endpoint implements a small interface, is
registered in DI like any other service, and maps itself at startup. No separate `Map...` chain:

```csharp
public interface IEndpoint
{
    void Map(IEndpointRouteBuilder app);
}

internal sealed class GetOrderEndpoint : IEndpoint
{
    public void Map(IEndpointRouteBuilder app) =>
        app.MapGet("/v1/orders/{id:int}", HandleAsync)
           .RequireAuthorization(Scopes.OrdersRead)
           .WithTags("Orders");

    private static async Task<Ok<OrderResponse>> HandleAsync(int id, GetOrderQuery query, CancellationToken ct) =>
        TypedResults.Ok(await query.ExecuteAsync(id, ct));
}

public static class AddGetOrderExtension
{
    public static IServiceCollection AddGetOrder(this IServiceCollection services)
    {
        services.TryAddScoped<GetOrderQuery>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IEndpoint, GetOrderEndpoint>());
        return services;
    }
}
```

```csharp
// Program.cs, once
foreach (var endpoint in app.Services.GetServices<IEndpoint>())
{
    endpoint.Map(app);
}
```

One registration per endpoint instead of two. The trade-off: you lose the explicit route group
hierarchy in code, so shared settings (version prefix, tags, auth) need a base group passed into
`Map`. I like it for large APIs; for small ones, explicit `Map...` calls are easier to follow.

Note that the handler is a **static** method with its dependencies as parameters, resolved per
request. The endpoint class itself is a singleton used only at startup. Injecting a scoped service
into its constructor would be a captive dependency.

## Thin, whichever you choose

Both styles share the same rules, and they're what actually keeps an API maintainable. The controller
guidelines I've worked with put them like this:

- An endpoint is a **gateway**: it turns HTTP into a call and the result back into HTTP.
- **No business logic, no validation logic, no `try/catch`** in the endpoint.
- **One dependency**: the thing that handles the request (a mediator, a handler, a query).
- **Explicit authorization** on every endpoint.
- **Declared success and error responses** on every endpoint.

Those rules were enforced by Roslyn-based code rule tests. For example: a controller constructor may
only take one parameter, and an action body may only contain the single delegating call. That level
of strictness sounds pedantic until you've seen the alternative, where every controller is a little
different.

## When I still pick controllers

- An existing controller codebase. Don't rewrite working endpoints for style; new features can use
  minimal APIs side by side in the same app.
- Heavy use of MVC-specific features: custom model binders, OData, complex content negotiation.
- A team that knows MVC well and has no AOT or performance pressure.

Everything else, I start with minimal APIs.

## Pitfalls

**Lambdas in `Program.cs`.** The demo style. Fine for a sample, the "monster" for anything real.

**Missing `[AsParameters]` for many parameters.** A handler with eight query parameters is hard to
read. Group them in a record with `[AsParameters]`.

**Forgetting the group conventions.** Auth, tags and filters set on a `MapGroup` apply to all
endpoints in it. An endpoint mapped outside the group silently misses them. The fallback policy from
the JWT post is your safety net.

**Mixing styles without rules.** Controllers and minimal APIs in one app work fine technically. Make
the rule explicit ("new endpoints use minimal APIs") or you get two half-conventions.

## How to enforce it

- A **code rule test** that endpoint handlers have exactly one non-framework dependency, and that
  endpoint files contain no `try` statements.
- A test that enumerates `EndpointDataSource` and asserts every endpoint has authorization metadata,
  a name, and at least one error response declared.
- An architecture test that endpoint namespaces don't reference data access namespaces directly.

## Summary

- The scaling problem of minimal APIs was **structure, not syntax**.
- Minimal APIs give you **per-endpoint dependencies**, **typed results** that document themselves,
  less overhead and **AOT** support. Controllers still win on MVC-specific extensibility.
- Organize endpoints **per feature and action**, with `Add...`/`Map...` per module, or let endpoints
  **register themselves** via an `IEndpoint` interface.
- Whatever you choose: **thin endpoints**, one dependency, explicit auth, declared responses,
  **enforced by tests**.

*Previous: [A health endpoint that tells the truth](/blog/2026-a-health-endpoint-that-tells-the-truth/) ·
Next: [Why there is no try/catch in my endpoints](/blog/2026-no-try-catch-in-endpoints/)*
