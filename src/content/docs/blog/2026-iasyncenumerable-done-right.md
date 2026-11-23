---
title: IAsyncEnumerable done right
date: 2026-11-23
authors: rene
tags: [dotnet, async, aspnetcore, performance]
excerpt: Async streams are one of the nicest features in modern C#, and one of the easiest to use half-right. The cancellation token that never arrives, the stream that gets enumerated twice, the DbContext that's gone mid-stream, and when a plain Task<List<T>> is the better choice.
---

:::note[Series]
Part of the series [*.NET pitfalls*](/series/dotnet-pitfalls/).
:::

`IAsyncEnumerable<T>` lets you produce and consume a sequence one item at a time, asynchronously.
For exports, imports, paging through APIs or streaming large query results, that's exactly what you
want: constant memory, the first item arrives early, and the consumer controls the pace.

It also comes with a handful of traps that the compiler only half-warns you about. The first one
usually shows up as a warning that nobody reads.

## The warning everyone ignores: CS8425

```csharp
public async IAsyncEnumerable<OrderWithLines> LoadOrdersWithLinesAsync(
    IReadOnlyList<Order> orders,
    CancellationToken ct)          // ⚠️ CS8425
{
    foreach (var order in orders)
    {
        var lines = await orderLines.GetForOrderAsync(order.Id, ct);
        yield return new OrderWithLines(order, lines);
    }
}
```

> CS8425: Async-iterator has one or more parameters of type 'CancellationToken' but none of them is
> decorated with the 'EnumeratorCancellation' attribute, so the cancellation token parameter from the
> generated 'IAsyncEnumerable<>.GetAsyncEnumerator' will be unconsumed.

It sounds like noise. It isn't. An async stream can receive a cancellation token in **two** ways:

1. As a method argument: `LoadOrdersWithLinesAsync(orders, ct)`.
2. Later, from the consumer: `await foreach (var x in stream.WithCancellation(ct))`.
   ASP.NET Core does this too when it serializes a stream you return from an endpoint: it passes the
   request-aborted token through `GetAsyncEnumerator(token)`.

Without the attribute, the second token is silently dropped. The client disconnects, ASP.NET Core
cancels, and your iterator keeps loading order lines for nobody.

The fix is one attribute:

```csharp
using System.Runtime.CompilerServices;

public async IAsyncEnumerable<OrderWithLines> LoadOrdersWithLinesAsync(
    IReadOnlyList<Order> orders,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    foreach (var order in orders)
    {
        ct.ThrowIfCancellationRequested();
        var lines = await orderLines.GetForOrderAsync(order.Id, ct);
        yield return new OrderWithLines(order, lines);
    }
}
```

With `[EnumeratorCancellation]`, the compiler combines both tokens: the one passed as an argument and the
one passed to `GetAsyncEnumerator`. Whichever is cancelled first stops the iterator. There's no reason to
leave this warning as a warning. Make it an error.

## Pitfall 2: the stream is lazy, and it runs again

An async iterator doesn't do anything when you call it. It runs when someone enumerates it, and it
runs **again every time** someone enumerates it.

```csharp
var orders = repository.StreamOrdersAsync(customerId, ct);

var count = await orders.CountAsync(ct);          // query #1
await foreach (var order in orders) { /* ... */ } // query #2, possibly different data
```

That's the same multiple-enumeration problem as `IEnumerable<T>` with LINQ, with one difference: each
enumeration here is a database query or a remote call. If you need the data twice, materialize it once
(`ToListAsync`), or restructure the code so a single pass does both.

The laziness also moves exceptions. Argument validation in an iterator only runs on the first
`MoveNextAsync`, which may be far away from the call. If you want to fail fast, split the method:

```csharp
public IAsyncEnumerable<Order> StreamOrdersAsync(CustomerId customerId, CancellationToken ct = default)
{
    ArgumentNullException.ThrowIfNull(customerId);   // runs immediately
    return StreamOrdersCore(customerId, ct);
}

private async IAsyncEnumerable<Order> StreamOrdersCore(
    CustomerId customerId,
    [EnumeratorCancellation] CancellationToken ct)
{
    // ...
}
```

## Pitfall 3: the DbContext is gone halfway through

Streaming an EF Core query is a nice way to process a large table with flat memory:

```csharp
public IAsyncEnumerable<Order> StreamOpenOrders() =>
    db.Orders.Where(o => o.Status == OrderStatus.Open).AsNoTracking().AsAsyncEnumerable();
```

The catch: while the stream is being enumerated, the `DbContext` and its open connection are in use.
If the consumer enumerates it after the scope is disposed, it throws. And if the consumer does other
database work on the same context **inside** the loop, you get *"A second operation was started on
this context instance"*, because the reader is still open.

Rules that keep you out of trouble:

- The scope that owns the context must outlive the enumeration. In ASP.NET Core, returning the stream
  from an endpoint is fine: the request scope lives until the response is written.
- Don't hand a context-backed stream to a background task or store it for later.
- Inside the loop, don't use the same context. Collect IDs or use a second context from
  `IDbContextFactory<T>`.
- A long-running enumeration keeps a connection open. For very long jobs, page explicitly with keyset
  pagination instead (`WHERE Id > @lastId ORDER BY Id`).

## Pitfall 4: buffering it all anyway

```csharp
var all = await StreamOrdersAsync(customerId, ct).ToListAsync(ct);   // why stream then?
return all;
```

If every caller calls `ToListAsync` immediately, you've added a state machine and gained nothing. That's
also a hint about when **not** to use `IAsyncEnumerable<T>`:

| Situation | Return type |
|---|---|
| Small result, needed as a whole (a page of 50, a lookup) | `Task<IReadOnlyList<T>>` |
| Large or unbounded result, processed item by item | `IAsyncEnumerable<T>` |
| Producer and consumer run at different speeds, possibly on different threads | `Channel<T>` (expose its reader as `IAsyncEnumerable<T>`) |
| You need the count, sorting or random access | `Task<IReadOnlyList<T>>` |
| Streaming an HTTP response (export, NDJSON, large JSON array) | `IAsyncEnumerable<T>` |

## Pitfall 5: no backpressure thinking

The beauty of `await foreach` is that the producer only produces the next item when the consumer asks
for it. That's natural backpressure. It's easy to break it:

```csharp
// ❌ fires off all calls at once, then streams the results
public async IAsyncEnumerable<Product> LoadAllAsync(IEnumerable<int> ids,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    var tasks = ids.Select(id => catalog.GetProductAsync(id, ct)).ToList();
    foreach (var task in tasks)
        yield return await task;
}
```

This starts every request before the first item is yielded. If you want limited concurrency while
streaming, use a bounded channel with a few workers, or `Parallel.ForEachAsync` writing into a channel.
In .NET 9 and later, `Task.WhenEach` is a good fit if the number of tasks is small and you just want
them in completion order.

## Consuming streams: the building blocks

**LINQ.** Since .NET 10, LINQ over `IAsyncEnumerable<T>` ships with the framework
(`System.Linq.AsyncEnumerable`): `Where`, `Select`, `Take`, `ToListAsync` and friends. Before that, you
needed the community `System.Linq.Async` package. When you move to .NET 10, remove that package
reference, otherwise you get ambiguous-call errors.

**HTTP.** `HttpClient` can deserialize a JSON array as it arrives:

```csharp
await foreach (var product in http.GetFromJsonAsAsyncEnumerable<Product>("products/export", ct))
{
    await index.UpdateAsync(product!, ct);
}
```

**ASP.NET Core endpoints.** Returning `IAsyncEnumerable<T>` streams the JSON array to the client with
`System.Text.Json`, without buffering:

```csharp
app.MapGet("/orders/export", (OrderRepository repository, CancellationToken ct) =>
    repository.StreamOpenOrders());
```

If the first item fails, you still get a proper error response. If item 10,000 fails, the status code
`200` has already been sent, and the client receives a truncated array. That's inherent to streaming.
Clients of a streaming endpoint must treat incomplete JSON as a failure, and you should log errors in
the iterator itself.

**Parallel processing.** `Parallel.ForEachAsync` accepts an `IAsyncEnumerable<T>` directly, so you can
stream in and process with bounded concurrency in one line.

**Libraries and ConfigureAwait.** In library code,
`await foreach (var x in source.WithCancellation(ct).ConfigureAwait(false))` is the full form. See
[ConfigureAwait(false) in 2026](/blog/2026-configureawait-false-explained/) for when that matters.

## Exceptions and cleanup

`try`/`finally` works in async iterators, and so does `await using`. The `finally` runs when the loop
completes, when the consumer `break`s out early, or when an exception occurs, because `await foreach`
disposes the enumerator. That's the place for cleanup.

What you can't do is `yield return` inside a `try` block that has a `catch`. If you need to handle
errors per item, wrap the risky call, not the `yield`:

```csharp
public async IAsyncEnumerable<ImportResult> ImportAsync(
    IAsyncEnumerable<ProductRow> rows,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    await foreach (var row in rows.WithCancellation(ct))
    {
        ImportResult result;
        try
        {
            await importer.ImportAsync(row, ct);
            result = ImportResult.Ok(row.Sku);
        }
        catch (ValidationException ex)
        {
            result = ImportResult.Failed(row.Sku, ex.Message);
        }

        yield return result;
    }
}
```

## Make it stick

- **Treat CS8425 as an error.** One line in `.editorconfig`:
  `dotnet_diagnostic.CS8425.severity = error`.
- **Test cancellation explicitly.** Enumerate with `WithCancellation` on a token that's cancelled after
  the first item, and assert the iterator stops and the downstream fake saw no more calls.

```csharp
[TestMethod]
public async Task Stream_stops_when_consumer_cancels()
{
    using var cts = new CancellationTokenSource();
    var lines = new CountingOrderLineClient();
    var sut = new OrderStreamer(lines);

    await Assert.ThrowsExactlyAsync<OperationCanceledException>(async () =>
    {
        await foreach (var _ in sut.LoadOrdersWithLinesAsync(TestData.Orders(100)).WithCancellation(cts.Token))
            cts.Cancel();
    });

    Assert.AreEqual(1, lines.Calls);
}
```

That test fails as soon as someone removes `[EnumeratorCancellation]`, which is exactly the regression
you want to catch.

## Summary

- Put **`[EnumeratorCancellation]`** on the token parameter of every async iterator. CS8425 is a real
  bug, not a style warning.
- Async streams are **lazy and re-run** on every enumeration. Materialize once if you need the data twice.
- A stream backed by a **`DbContext`** needs the context alive and idle for the whole enumeration.
- Don't stream what every caller buffers anyway. **`Task<IReadOnlyList<T>>`** is fine for small results.
- Keep the natural **backpressure**. Don't start all the work before the first `yield`.
- Use the built-in **LINQ for async streams** in .NET 10 and remove `System.Linq.Async`.
- Remember that a streaming HTTP response has already sent its **200** when a late item fails.
