---
title: "MediatR pipeline behaviors: validation and caching without touching a handler"
date: 2026-11-25
draft: true
authors: rene
tags: [cqrs, caching, validation]
excerpt: Every query handler checks its input and every expensive query has the same five lines of cache code. Pipeline behaviors move both out of the handlers into one place. A validation behavior that reports all errors at once, a caching behavior built on HybridCache, and the ordering and key mistakes that will bite you.
---

:::note[Series]
Part of the series [*Architecture in practice*](/series/architecture-in-practice/).
:::

Open any ten query handlers in a typical codebase and you'll find the same two blocks at the top of
most of them. First, input checks: `if (string.IsNullOrWhiteSpace(request.Name)) throw ...`. Second,
cache code: build a key, look it up, call the database if it's not there, write it back with an
expiration. The actual business logic starts at line 25.

Neither block is business logic. Both are the same everywhere, with small variations that are mostly
accidental. This is exactly the job of MediatR's **pipeline behaviors**: code that wraps every request
on its way to the handler, written once.

This post builds two of them: **validation** and **caching**. If you're new to the request/handler
style, start with [*CQRS with MediatR, without the ceremony*](/blog/2026-cqrs-with-mediatr-without-ceremony/).

## How the pipeline works

A behavior is a middleware for MediatR requests. It gets the request and a `next` delegate, and
decides what happens before and after the handler runs:

```mermaid
flowchart LR
    S["sender.Send(request)"] --> L[Logging behavior]
    L --> V[Validation behavior]
    V --> C[Caching behavior]
    C --> H[Handler]
    H --> C --> V --> L --> S
```

Behaviors are registered as open generics, so one class handles every request type:

```csharp
builder.Services.AddMediatR(cfg =>
{
    cfg.RegisterServicesFromAssemblyContaining<Program>();
    cfg.AddOpenBehavior(typeof(LoggingBehavior<,>));
    cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    cfg.AddOpenBehavior(typeof(CachingBehavior<,>));
});
```

The registration order is the execution order. Keep that in mind; it matters more than it seems.

## Validation behavior

What I want from validation:

- No validation code in endpoints or handlers.
- No validation attributes on request records. They're data, nothing else.
- Validation can be async if it really must be.
- **All errors are reported at once**, not just the first one.
- Requests without a validator just pass through.

First, a minimal validator contract:

```csharp
public interface IRequestValidator<in TRequest>
{
    ValueTask<IReadOnlyDictionary<string, string[]>> ValidateAsync(TRequest request, CancellationToken ct);
}
```

A validator for one query:

```csharp
namespace MyShop.Api.Customers.V1;

internal sealed class SearchCustomersValidator : IRequestValidator<SearchCustomers>
{
    public ValueTask<IReadOnlyDictionary<string, string[]>> ValidateAsync(SearchCustomers request, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(request.Name))
            errors["name"] = ["Must not be empty or whitespace."];

        if (request.PageSize is < 1 or > 200)
            errors["pageSize"] = ["Must be between 1 and 200."];

        return ValueTask.FromResult<IReadOnlyDictionary<string, string[]>>(errors);
    }
}
```

And the behavior that runs all validators for a request:

```csharp
public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IRequestValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();

        foreach (var validator in validators)
        {
            foreach (var (key, messages) in await validator.ValidateAsync(request, ct))
            {
                errors[key] = errors.TryGetValue(key, out var existing)
                    ? [.. existing, .. messages]
                    : messages;
            }
        }

        if (errors.Count > 0)
            throw new RequestValidationException(errors);

        return await next(ct);
    }
}
```

`RequestValidationException` carries the error dictionary. One `IExceptionHandler` turns it into an RFC
9457 validation problem response for every endpoint:

```csharp
internal sealed class ValidationExceptionHandler(IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        if (exception is not RequestValidationException validation)
            return false;

        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext    = context,
            ProblemDetails = new HttpValidationProblemDetails(validation.Errors)
            {
                Status = StatusCodes.Status400BadRequest,
                Title  = "One or more validation errors occurred."
            },
            Exception = exception
        });
    }
}
```

Validators are registered per request type, next to the request and handler:
`services.AddSingleton<IRequestValidator<SearchCustomers>, SearchCustomersValidator>();`. If a
validator needs scoped services, register it as scoped.

:::note[Which MediatR version?]
The code uses the MediatR 12.5+ signature where `next` accepts a `CancellationToken`. On older 12.x
versions, call `next()` without arguments. The parameter order of `Handle` (request, next, token) is
the one from v12; older versions had the token second.
:::

### What belongs in a validator, and what doesn't

Validate the **shape of the request**: required values, ranges, formats, combinations of fields.
Don't validate things that need data the handler loads anyway. "Does customer 42 exist?" in the
validator means one database call in the validator and the same call again in the handler. That's
business logic, and it belongs in the handler, where the data is already available.

A good test: if the validator needs a repository or an HTTP client, it's probably doing the handler's job.

## Caching behavior

For caching, I want queries to opt in with a marker, and the handler not to know about it at all.

```csharp
public interface ICacheableQuery
{
    TimeSpan CacheDuration { get; }
    bool BypassCache => false;
}
```

```csharp
namespace MyShop.Api.Catalog.V1;

public sealed record GetProductCategories(string Language) : IRequest<IImmutableList<Category>>, ICacheableQuery
{
    public TimeSpan CacheDuration => TimeSpan.FromMinutes(10);
}
```

The behavior uses `HybridCache`, which is part of ASP.NET Core since .NET 9. It combines an in-memory
cache with an optional distributed one and protects against cache stampedes: if a hundred requests miss
the same key at once, the factory runs only once.

```csharp
public sealed class CachingBehavior<TRequest, TResponse>(HybridCache cache)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        if (request is not ICacheableQuery cacheable || cacheable.BypassCache)
            return await next(ct);

        var key = CacheKey.For(request);
        var options = new HybridCacheEntryOptions
        {
            Expiration = cacheable.CacheDuration,
            LocalCacheExpiration = cacheable.CacheDuration
        };

        return await cache.GetOrCreateAsync(
            key,
            next,
            static async (next, token) => await next(token),
            options,
            cancellationToken: ct);
    }
}
```

I check the marker at runtime instead of using a generic constraint. That keeps registration simple
(one open behavior for all requests) and avoids depending on how the DI container handles constrained
open generics.

The key is built from the request type and its serialized content:

```csharp
internal static class CacheKey
{
    public static string For<TRequest>(TRequest request) where TRequest : notnull
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(request, request.GetType());
        var hash = Convert.ToHexString(SHA256.HashData(json));
        return $"{request.GetType().FullName}:{hash}";
    }
}
```

Because requests are immutable records with only data, serializing them produces a stable key. That's
one more reason to keep requests free of logic and of things like `HttpRequest`.

```csharp
builder.Services.AddHybridCache();
// optional second level, e.g.:
// builder.Services.AddStackExchangeRedisCache(o => o.Configuration = "...");
```

The handler stays exactly as it was:

```csharp
internal sealed class GetProductCategoriesHandler(ShopDbContext db)
    : IRequestHandler<GetProductCategories, IImmutableList<Category>>
{
    public async Task<IImmutableList<Category>> Handle(GetProductCategories request, CancellationToken ct) =>
        (await db.Categories
                 .Where(c => c.Language == request.Language)
                 .Select(c => new Category(c.Id, c.Name))
                 .ToListAsync(ct))
        .ToImmutableList();
}
```

Turning caching on or off for a query is now one interface on the record. No cache keys to invent, no
expiration logic to copy.

## Ordering matters

| Order | Effect |
|---|---|
| Logging → Validation → Caching → Handler | ✅ Invalid requests are rejected before the cache. Every request is logged, including cache hits. |
| Caching → Validation | ❌ Cache hits skip everything after the cache. Harmless for pure shape checks, dangerous as soon as a later behavior also enforces access rules. |
| Validation after a transaction behavior | ❌ You open a transaction for a request you're about to reject. |

My default order: logging/metrics, validation, authorization checks that depend on the request, caching,
transactions (for commands), handler.

## Pitfalls

**User-specific data in a shared cache.** If the result depends on the current user or tenant, and that
isn't part of the request, two users get each other's data. Either put the user or tenant id into the
request record explicitly, or don't cache that query. This is the most dangerous mistake on this list.

**Caching commands.** The marker is for queries. A cached command silently does nothing on the second
call. A test that checks `ICacheableQuery` is only implemented by requests whose name starts with `Get`,
`Search` or `List` is cheap insurance.

**Nested sends run the pipeline again.** If a handler sends another query through the mediator, that
query goes through validation and caching too. Often that's what you want: the inner query is cached on
its own. Just be aware of it when you read logs or measure time.

**Validators that throw on the first error.** Then you're back to "fix one, retry, find the next".
Collect, then throw once.

**No way to bypass the cache.** Support and testers need to see fresh data. `BypassCache` as a request
property (fed from a header or query parameter for privileged users) solves that without code changes.

**Big responses in the distributed cache.** Every hit costs a network round trip and a deserialization.
Measure whether the second level actually helps for large objects.

## Test the behaviors once, not per handler

Behaviors are generic, so they're tested once with a fake request. For caching, a counting handler proves
the second call doesn't reach it:

```csharp
public sealed record CountedQuery(int Value) : IRequest<int>, ICacheableQuery
{
    public TimeSpan CacheDuration => TimeSpan.FromMinutes(1);
}

public sealed class CountedQueryHandler : IRequestHandler<CountedQuery, int>
{
    public static int Calls;
    public Task<int> Handle(CountedQuery request, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        return Task.FromResult(request.Value);
    }
}

[TestMethod]
public async Task Second_identical_query_is_served_from_cache()
{
    var sender = Services.GetRequiredService<ISender>();

    await sender.Send(new CountedQuery(1));
    await sender.Send(new CountedQuery(1));
    await sender.Send(new CountedQuery(2));

    Assert.AreEqual(2, CountedQueryHandler.Calls);   // 1 hit, 2 misses
}
```

The validation behavior gets the same treatment: one request with two invalid fields, one assertion that
both keys appear in the exception. After that, individual validators only need tests if their rules are
non-trivial.

## Summary

- Pipeline behaviors move **cross-cutting code** out of handlers into one generic place.
- The **validation behavior** runs all validators for a request, collects every error, and throws once. A
  central exception handler turns that into a 400 problem response.
- Validators check the **shape** of a request. Checks that need data belong in the handler.
- The **caching behavior** uses a marker interface and `HybridCache`. Keys come from the request type and
  its serialized content, which works because requests are immutable records.
- **Order matters**, never cache per-user data without the user in the key, and test behaviors once with
  a fake request.
