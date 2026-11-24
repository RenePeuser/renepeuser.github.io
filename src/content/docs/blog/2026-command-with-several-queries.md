---
title: A command that needs several queries
date: 2026-11-23
authors: rene
tags: [architecture, cqrs, performance]
excerpt: Placing an order needs the customer, the prices and the stock before anything is written. Should the command handler send queries through the mediator, inject them, or load everything itself? The options, how to run the reads in parallel without breaking your DbContext, and when the "command" is really a query in disguise.
---


The CQRS samples always show a query that reads one thing and a command that writes one thing. Then
you implement your first real feature and the command needs four reads before it can write anything.
Placing an order needs the customer (is it blocked?), the current prices, the stock levels and the
shipping rules. Each of those reads already exists as a query somewhere.

So what do you do inside the command handler? Send those queries through the mediator? Inject the
query handlers? Write the reads again inline? This post goes through the options I've used, and the
one mistake that turns "let's load it in parallel" into a production incident.

## The naive version: sequential, inline

```csharp
internal sealed class PlaceOrderHandler(ShopDbContext db, IPricingClient pricing)
    : IRequestHandler<PlaceOrder, PlaceOrderResult>
{
    public async Task<PlaceOrderResult> Handle(PlaceOrder request, CancellationToken ct)
    {
        var customer = await db.Customers.SingleAsync(c => c.Id == request.CustomerId, ct);
        if (customer.IsBlocked)
            throw new ConflictException("Customer is blocked.");

        var prices = await pricing.GetPricesAsync(request.ProductIds, ct);
        var stock  = await db.Stock.Where(s => request.ProductIds.Contains(s.ProductId)).ToListAsync(ct);
        var rules  = await db.ShippingRules.Where(r => r.Country == customer.Country).ToListAsync(ct);

        // ... write the order
    }
}
```

It works, but two things bother me:

1. **Duplication.** The stock query and the shipping rules query already exist as `GetStockLevels` and
   `GetShippingRules` for their own endpoints. Now there are two versions that will drift apart.
2. **Sequential latency.** Prices come from a remote service, stock and rules from the database. None
   of them depends on the others, but they run one after another.

## Option 1: send queries through the mediator

The pattern I found in one team's guidelines was a command handler that sends queries via MediatR and
awaits them together:

```csharp
internal sealed class PlaceOrderHandler(ISender sender, ShopDbContext db)
    : IRequestHandler<PlaceOrder, PlaceOrderResult>
{
    public async Task<PlaceOrderResult> Handle(PlaceOrder request, CancellationToken ct)
    {
        var customerTask = sender.Send(new GetCustomer(request.CustomerId), ct);
        var pricesTask   = sender.Send(new GetPrices(request.ProductIds), ct);
        var stockTask    = sender.Send(new GetStockLevels(request.ProductIds), ct);

        await Task.WhenAll(customerTask, pricesTask, stockTask);

        var customer = await customerTask;
        if (customer.IsBlocked)
            throw new ConflictException("Customer is blocked.");

        var rules = await sender.Send(new GetShippingRules(customer.Country), ct);   // depends on customer

        // ... write the order with db
    }
}
```

**Pros:** every read is reused. Each nested query goes through the pipeline again, so if `GetPrices` is
cacheable, the command benefits from the cache for free. The handler reads like a recipe.

**Cons:** the handler's real dependencies are hidden behind `ISender`. You can't see from the
constructor that this command touches pricing, stock and shipping. Validation runs again for each nested
query. And there's a trap with the database, which I'll come to in a moment.

## Option 2: inject the queries directly

Without a mediator, or if you prefer explicit dependencies, inject the query classes:

```csharp
internal sealed class PlaceOrderCommand(
    GetCustomerQuery getCustomer,
    GetPricesQuery getPrices,
    GetStockLevelsQuery getStock,
    GetShippingRulesQuery getShippingRules,
    ShopDbContext db)
{
    public async Task<PlaceOrderResult> ExecuteAsync(PlaceOrder request, CancellationToken ct)
    {
        var customerTask = getCustomer.ExecuteAsync(request.CustomerId, ct);
        var pricesTask   = getPrices.ExecuteAsync(request.ProductIds, ct);
        var stockTask    = getStock.ExecuteAsync(request.ProductIds, ct);
        await Task.WhenAll(customerTask, pricesTask, stockTask);
        // ...
    }
}
```

**Pros:** the constructor tells the full story. F12 goes straight to the code. No reflection, no pipeline
surprises.

**Cons:** cross-cutting behavior (caching, metrics) has to be added via decorators or explicitly. The
constructor gets long for complex commands, which is honest, but noticeable.

## Option 3: a context builder

When several commands need the same set of reads, I extract them into one builder that loads everything
once, in parallel, and returns an immutable context object. That's the
[Request Context Builder](/blog/2026-request-context-builder/) pattern, covered in its own post. The command
then gets one dependency instead of four.

## Comparison

| | Inline reads | Queries via mediator | Injected queries | Context builder |
|---|---|---|---|---|
| Reuses existing reads | ❌ | ✅ | ✅ | ✅ |
| Dependencies visible in constructor | ✅ | ❌ only `ISender` | ✅ | ✅ one builder |
| Pipeline (cache, metrics) for inner reads | ❌ | ✅ automatically | ⚠️ manually | ⚠️ manually |
| F12 navigation | ✅ | ❌ | ✅ | ✅ |
| Shared across several commands | ❌ | ⚠️ each repeats the calls | ⚠️ each repeats the calls | ✅ |
| Good for | one-off, simple reads | MediatR codebases with cached queries | codebases without a mediator | many commands, same data |

There's no single winner. In a MediatR codebase with good cached queries, option 1 is pragmatic. If
explicit dependencies matter more to you, option 2. If you see the same four reads at the top of several
commands, it's time for option 3.

## The trap: parallel reads on one DbContext

This is the line that looks innocent:

```csharp
await Task.WhenAll(customerTask, pricesTask, stockTask);
```

If `GetCustomer` and `GetStockLevels` both use the **same scoped `ShopDbContext`**, which is the default in
ASP.NET Core, this throws at runtime:

```text
System.InvalidOperationException: A second operation was started on this context instance before a
previous operation completed. This is usually caused by different threads concurrently using the same
instance of DbContext.
```

`DbContext` is not thread-safe, and two concurrent queries on one instance are not allowed. The nasty part:
it often works in development, because the first query finishes before the second starts. It fails under
load.

The fixes, in the order I'd consider them:

**1. Only parallelize what's independent of the database.** Remote calls (pricing, a catalog API) run in
parallel; database reads on the shared context run sequentially. Often that's already most of the gain.

```csharp
var pricesTask = getPrices.ExecuteAsync(request.ProductIds, ct);       // HTTP, runs in the background

var customer = await getCustomer.ExecuteAsync(request.CustomerId, ct); // DB
var stock    = await getStock.ExecuteAsync(request.ProductIds, ct);    // DB, sequential

var prices = await pricesTask;
```

**2. Give parallel database reads their own context.** Register `AddDbContextFactory<ShopDbContext>()` and
let read-only queries create a short-lived context:

```csharp
internal sealed class GetStockLevelsQuery(IDbContextFactory<ShopDbContext> contextFactory)
{
    public async Task<IReadOnlyList<StockLevel>> ExecuteAsync(IReadOnlyList<string> productIds, CancellationToken ct)
    {
        await using var db = await contextFactory.CreateDbContextAsync(ct);
        return await db.Stock.AsNoTracking()
                       .Where(s => productIds.Contains(s.ProductId))
                       .Select(s => new StockLevel(s.ProductId, s.Available))
                       .ToListAsync(ct);
    }
}
```

Each parallel query now uses its own connection from the pool. Keep the **write** on the scoped context, so
the command still has one unit of work.

**3. Combine the reads into one query.** Sometimes three queries against the same database are better as one
query with a join or a split query. Fewer round trips beat parallel round trips.

## Is it really a command?

One more thing I noticed in the same guidelines: a "command" that built statistics, mapped to a
`POST`, that ran two SQL queries in parallel, combined the results and returned them. It didn't write
anything.

That's a **query**. It used `POST` because the filter was too large for a query string, and from there
"POST means command" is an easy step to take. The distinction matters in practice: queries can be cached, retried safely
and run against a read replica. Commands can't. Name and type it by what it does:

```csharp
public sealed record BuildOrderStatistics(OrderStatisticsFilter Filter) : IRequest<OrderStatistics>, ICacheableQuery
{
    public TimeSpan CacheDuration => TimeSpan.FromMinutes(5);
}
```

The endpoint can still be `POST /v1/order-statistics/search`. HTTP verb and CQRS role are two separate
decisions.

## Pitfalls

**Commands that call commands.** A command that sends another command creates nested units of work and
unclear transaction boundaries. If two state changes must happen together, they belong in one command. If
they're independent, raise an event and let something else react.

**Validation running twice.** The outer command validates its request; each nested query validates its own.
That's fine for cheap shape checks, but don't put expensive checks in query validators.

**Ignoring partial failure.** `Task.WhenAll` waits for all tasks, even after one has already failed, and then
rethrows only the first exception. Pass the same `CancellationToken` to all of them, and use a linked
`CancellationTokenSource` that you cancel on the first failure if the others shouldn't keep working for nothing.

**Reading after writing in the same command.** Loading data, writing, and then sending a cached query that
reads the same data gives you the stale cached value. After a write, bypass the cache or build the result
from what you just wrote.

## Measure it

Two things are worth checking with real numbers rather than gut feeling:

- **Latency per dependency.** With OpenTelemetry, each database and HTTP call is a span. Look at the trace of
  one *place order* request: if the spans are lined up one after the other although they don't depend on each
  other, there's room for parallelism. If they overlap, it's working.
- **Number of calls.** Count dependency spans per operation. If placing an order triggers the customer query
  three times (once in the command, once in a nested query, once in a validator), the trace shows it
  immediately.

An integration test can guard the `DbContext` problem: run a few dozen *place order* requests concurrently
against the test server. The concurrency exception shows up there long before it shows up in production.

## Summary

- A command that needs several reads can **inline** them, **send queries** through the mediator, **inject
  query classes**, or use a **context builder**. Pick based on visibility of dependencies and reuse.
- Parallelize reads with `Task.WhenAll`, but **never run concurrent queries on one scoped `DbContext`**. Use
  `IDbContextFactory` for parallel reads, or keep database reads sequential.
- Keep the **write** on one context so the command stays a single unit of work.
- A `POST` that only reads is a **query**. Type it as one, and you get caching and safe retries.
- Check with traces whether your reads really run in parallel and how often each one runs.
