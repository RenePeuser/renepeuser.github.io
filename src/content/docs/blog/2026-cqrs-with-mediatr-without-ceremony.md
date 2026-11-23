---
title: CQRS with MediatR, without the ceremony
date: 2026-11-23
authors: rene
tags: [architecture, cqrs, aspnetcore]
excerpt: CQRS doesn't need two databases, event sourcing or a message bus. In most APIs it simply means "a request either reads or writes", and every request gets its own small handler. How I use MediatR for that, the conventions that keep it navigable, the licensing change since v13, and when I'd skip the library entirely.
---

:::note[Series]
Part of the series [*Architecture in practice*](/series/architecture-in-practice/).
:::

Say "CQRS" in an architecture meeting and someone draws two databases, an event store and a
message bus on the whiteboard. Then everyone agrees it's too complex for this project, and you
keep the `OrderService` with its fifteen methods.

That's a shame, because the useful core of CQRS is tiny: **a request either changes state or reads
it, never both.** Everything else, separate read stores, event sourcing, eventual consistency, is
optional and only worth it for specific problems.

This post shows the lightweight version I use in APIs: one command or query per use case, one handler
each, dispatched through MediatR. Plus the conventions that make it work in a team, and an honest
look at when you don't need the library.

## The "before": a facade that knows everything

In one codebase I worked on, a controller for one domain looked roughly like this:

```csharp
[ApiController]
[Route("v1/orders")]
public sealed class OrdersController(OrderFacade facade) : ControllerBase
{
    [HttpPost]
    public Task<OrderDto> Place(PlaceOrderRequest request) => facade.PlaceAsync(Request, request);

    [HttpPost("search")]
    public Task<SearchResult> Search(OrderFilter filter, int page = 0) => facade.SearchAsync(Request, filter, page);

    [HttpPost("{id}/export")]
    public Task<Stream> Export(int id, ExportFormat format) => facade.ExportAsync(Request, id, format);
    // ...
}
```

And the facade behind it had **twelve** injected services: one for updates, one for imports, one for
exports, one for deletes, schema helpers, file readers, and so on. Every new feature added another
constructor parameter. Every test of any method had to construct all twelve. The controller passed
`HttpRequest` into the facade, so none of it was usable outside HTTP.

The facade wasn't badly written. It was the natural result of "one service per domain".

## The idea: one request, one handler

Replace the facade with one small class per use case. Each use case has a **request** (the input,
as an immutable record) and a **handler** (the logic). Reads are *queries*, writes are *commands*.

REST maps onto that almost one to one:

| HTTP method | CQRS |
|---|---|
| `GET` | Query |
| `POST` | Command (or a query, see below) |
| `PUT` | Command |
| `PATCH` | Command |
| `DELETE` | Command |

The one exception is `POST` for complex reads, like a search with a filter body that's too big for a
query string. That's still a query. Command or query is about **side effects**, not about the HTTP
verb.

## A query

```csharp
namespace MyShop.Api.Orders.V1;

public sealed record GetOrderById(int OrderId) : IRequest<Order?>;

internal sealed class GetOrderByIdHandler(ShopDbContext db) : IRequestHandler<GetOrderById, Order?>
{
    public async Task<Order?> Handle(GetOrderById request, CancellationToken ct) =>
        await db.Orders
                .AsNoTracking()
                .Where(o => o.Id == request.OrderId)
                .Select(o => new Order
                {
                    Id        = o.Id,
                    ProductId = o.Sku,
                    Status    = o.Status,
                    PlacedAt  = o.PlacedAt
                })
                .SingleOrDefaultAsync(ct);
}
```

A query handler reads, maps and returns. No tracking, no `SaveChanges`. Because it's isolated, it can
use whatever is fastest for this read: an EF projection, raw SQL, Dapper, a cache.

## A command

```csharp
namespace MyShop.Api.Orders.V1;

public sealed record CancelOrder(int OrderId, string Reason) : IRequest;

internal sealed class CancelOrderHandler(ShopDbContext db, TimeProvider time) : IRequestHandler<CancelOrder>
{
    public async Task Handle(CancelOrder request, CancellationToken ct)
    {
        var order = await db.Orders.SingleOrDefaultAsync(o => o.Id == request.OrderId, ct)
                    ?? throw new NotFoundException($"Order {request.OrderId} not found.");

        if (order.Status is OrderStatus.Shipped)
            throw new ConflictException("Shipped orders can't be cancelled.");

        order.Status = OrderStatus.Cancelled;
        order.CancelledAt = time.GetUtcNow();
        order.CancellationReason = request.Reason;

        await db.SaveChangesAsync(ct);
    }
}
```

A command without a result implements `IRequest` and `IRequestHandler<TRequest>` and returns a plain
`Task`. Older MediatR versions forced `Task<Unit>` for that. Since v12 you don't need it, and I'd
treat any remaining `Unit` as cleanup material.

## The endpoint

```csharp
group.MapGet("orders/{orderId:int}", async (int orderId, ISender sender, CancellationToken ct) =>
        await sender.Send(new GetOrderById(orderId), ct) is { } order
            ? TypedResults.Ok(order)
            : Results.NotFound())
     .WithName("getOrderByIdV1");

group.MapPost("orders/{orderId:int}/cancellation", async (int orderId, CancelOrderBody body, ISender sender, CancellationToken ct) =>
     {
         await sender.Send(new CancelOrder(orderId, body.Reason), ct);
         return TypedResults.NoContent();
     })
     .WithName("cancelOrderV1");
```

The endpoint builds a request and sends it. `ISender` is the narrower interface of `IMediator` that only
sends requests; I inject that instead of the full mediator. The endpoint has one dependency no matter
how many features the domain has.

## Registration

```csharp
builder.Services.AddMediatR(cfg =>
{
    cfg.RegisterServicesFromAssemblyContaining<Program>();
    cfg.LicenseKey = builder.Configuration["MediatR:LicenseKey"];   // v13+, see below
});
```

Call it **once** per assembly. I've seen a codebase where several modules each called the registration
for the same assembly. Request handlers survived that, but notification handlers were registered
several times and ran several times per event. That team ended up writing an architecture test that
banned direct calls and allowed only a wrapper that checks whether an assembly is already registered.

## What you gain

- **Small, isolated code paths.** Each handler has only the dependencies it needs. No facade that grows
  with every feature.
- **A clear read/write split.** You can see from the type whether something changes state.
- **Cross-cutting concerns in one place.** Validation, caching, logging and timing can be pipeline
  behaviors that run for every request without touching handler code. That's the topic of
  [*MediatR pipeline behaviors*](/blog/2026-mediatr-pipeline-behaviors/).
- **A structure that matches HTTP.** One endpoint, one request, one handler.

## What it costs

- **Indirection.** `sender.Send(new GetOrderById(42))` doesn't tell the IDE where the code is. F12 takes
  you to the record, not the handler. More in [*The cost of indirection*](/blog/2026-cost-of-indirection/).
- **Another dependency.** It's a library at the heart of every request.
- **A different mental model.** Developers used to services need to get used to requests and handlers.

## About MediatR's licensing

Since version 13 (released in 2025), MediatR is distributed under a dual license by its author's company:
a commercial license for organizations above a revenue threshold, and a free community license for
smaller companies, individuals and non-profits. Versions up to 12.x remain under Apache 2.0. Without a
license key, v13+ logs a warning at startup.

That's a perfectly legitimate decision by a maintainer who carried the library for years. For you, it
means: check the current terms, decide whether you pay, stay on 12.x for now, or move to an alternative.
Make that decision explicitly and write it down, for example as a
[lightweight ADR](/blog/2026-lightweight-adrs/).

## Do you need MediatR at all?

Not necessarily. The pattern is what matters, not the library. In another codebase the team decided
against MediatR on purpose and used plain command and query classes, injected directly:

```csharp
internal sealed class CancelOrderCommand(ShopDbContext db, TimeProvider time)
{
    public async Task ExecuteAsync(CancelOrder request, CancellationToken ct) { /* same logic */ }
}

group.MapPost("orders/{orderId:int}/cancellation",
    async (int orderId, CancelOrderBody body, CancelOrderCommand command, CancellationToken ct) =>
    {
        await command.ExecuteAsync(new CancelOrder(orderId, body.Reason), ct);
        return TypedResults.NoContent();
    });
```

Their reasons: fewer third-party dependencies, no reflection-based dispatch (they were heading towards
Native AOT), explicit dependencies visible at the call site, and simple APIs that didn't need a pipeline.
Validation was an explicit call at the top of each command instead of a behavior.

| | MediatR | Hand-rolled commands/queries | Source-generated mediator |
|---|---|---|---|
| One class per use case | ✅ | ✅ | ✅ |
| F12 goes to the logic | ❌ goes to the request | ✅ | ❌ goes to the request |
| Generic pipeline (validation, caching, logging) | ✅ behaviors | ⚠️ decorators or explicit calls | ✅ |
| Reflection at runtime | some | none | none |
| Native AOT | limited | ✅ | ✅ |
| Extra dependency / license | yes, commercial since v13 | none | yes, check license |

There are source-generated mediator libraries with a very similar API, if you like the pattern but want
compile-time dispatch. My rule of thumb: if you have real cross-cutting concerns (caching for many
queries, uniform validation, metrics per request), a mediator with behaviors pays for itself. If you
don't, plain classes are simpler.

## Conventions that keep it navigable

Whatever library you use, these rules made the biggest difference in practice:

1. **Requests are records.** Immutable, with value semantics. Collections are `IImmutableList<T>` or
   `IReadOnlyList<T>`.
2. **Requests contain data, not logic.** No methods, no validation attributes.
3. **Request and handler live in the same file.** That's the single most effective fix for the F12
   problem: jump to the request, and the handler is right below it.
4. **One handler per file, named after the use case.** `CancelOrder.cs` contains `CancelOrder` and
   `CancelOrderHandler`.
5. **Handlers don't know HTTP.** No `HttpRequest` in the request record. Pass the values the handler
   needs.

## Pitfalls

**Handlers calling handlers for everything.** Sending a query from a command handler is sometimes
right (see [*A command that needs several queries*](/blog/2026-command-with-several-queries/)). Building
deep chains of `Send` calls turns your code into a maze.

**Generic "CRUD" requests.** `UpdateEntity<T>` defeats the point. One request per use case.

**Using notifications as a message bus.** In-process notifications aren't durable. If the process
crashes after the command, the notification is gone. For real integration events, use an outbox and a
broker.

**Leaking `HttpRequest` into requests.** It's tempting to pass the whole request for headers or user
info. Extract what you need in the endpoint instead.

## Enforce the conventions

Two conventions are easy to check with reflection in a test:

```csharp
[TestMethod]
public void Requests_are_records_and_live_next_to_their_handler()
{
    var assembly = typeof(Program).Assembly;
    var handlers = assembly.GetTypes()
        .Where(t => t.GetInterfaces().Any(i => i.IsGenericType &&
               (i.GetGenericTypeDefinition() == typeof(IRequestHandler<,>) ||
                i.GetGenericTypeDefinition() == typeof(IRequestHandler<>))));

    foreach (var handler in handlers)
    {
        var requestType = handler.GetInterfaces().First(i => i.IsGenericType).GetGenericArguments()[0];

        // Records have a compiler-generated EqualityContract property.
        var isRecord = requestType.GetProperty("EqualityContract",
            BindingFlags.Instance | BindingFlags.NonPublic) is not null;
        Assert.IsTrue(isRecord, $"{requestType.Name} must be a record.");

        Assert.AreEqual($"{requestType.Name}Handler", handler.Name,
            $"Handler for {requestType.Name} must be named {requestType.Name}Handler.");
    }
}
```

The naming check is a proxy for "same file". A Roslyn-based test or analyzer can check the file
location itself. One team I worked with did exactly that, and the failure message printed the corrected
code. That's the [self-defending codebase](/blog/2026-self-defending-codebases/) idea again: the rule
explains itself the moment someone breaks it.

## Summary

- CQRS in an API can be as simple as **one request and one handler per use case**, split into
  commands and queries.
- Command or query depends on **side effects**, not on the HTTP verb.
- MediatR gives you dispatch and a pipeline for cross-cutting concerns. It costs indirection and, since
  v13, possibly a license.
- Hand-rolled command and query classes are a valid alternative when you don't need a pipeline.
- Requests are **immutable records**, live **in the same file as their handler**, and never carry
  `HttpRequest`. Check those rules in a test.
