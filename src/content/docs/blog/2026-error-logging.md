---
title: Error logging — log once, in one place, at the right level
date: 2026-11-23
authors: rene
tags: [dotnet, aspnetcore, error-handling, observability]
excerpt: The same exception logged four times on its way up, a 404 at Error level waking someone at night, and the one real failure buried in the noise. How to separate error logging from error handling, pick log levels by exception category and test that it works.
---


Open the error log of an API that has grown without a logging strategy, and you'll see the same
exception four times: once in the repository ("log and rethrow"), once in the service, once in the
controller's `catch` block and once more from the framework. In between, hundreds of "errors" that
are just customers asking for orders that don't exist. The one real database outage of the night is
somewhere in there.

The previous post set up **error handling**: turning exceptions into ProblemDetails responses. This
post is about **error logging**: making sure every failure is recorded exactly once, with enough
context and at a level that means something.

## Separate handling from logging

One codebase I worked on made this an explicit architecture decision: error handling and error
logging are two separate components. The handling side decides what the client sees. The logging
side decides what operations sees. They answer different questions, they change for different
reasons, and when they're mixed, both get worse.

The benefits they listed are the ones I'd list too:

- **One log structure** for every error, no matter which developer wrote the endpoint.
- **No `try/catch` blocks** just for logging. Code throws, the pipeline logs.
- **No `ILogger` in business code for error cases.** Explicit logging is for meaningful events, not
  for "something went wrong here".

## The "before": log and rethrow

```csharp
public async Task<Order> GetOrderAsync(int id, CancellationToken ct)
{
    try
    {
        return await repository.GetAsync(id, ct);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Failed to load order {OrderId}", id);
        throw;
    }
}
```

Every layer that does this adds one more copy of the same exception to the log. Worse, when the
exception is a `NotFoundProblem`, it's logged at `Error` even though nothing is broken. The fix is
not "be more careful". The fix is to **not log here at all**.

## Where the framework already logs

With `UseExceptionHandler()`, the exception handler middleware logs unhandled exceptions as
`Error` ("An unhandled exception has occurred while executing the request"). On .NET 10, that changed:
when an `IExceptionHandler` reports the exception as handled, the middleware **no longer** writes
that log entry by default. You can control it with `ExceptionHandlerOptions.SuppressDiagnosticsCallback`.

That's a good default, but it means: **if your handler handles it, your handler is responsible for
logging it.** On older versions, you get the framework entry *plus* whatever you log yourself.
Either way, it's worth writing a test that pins down what actually ends up in the log (see below).

## A logging handler that only logs

`IExceptionHandler`s run in registration order until one returns `true`. So the cleanest
separation is a handler that **logs and returns `false`**, registered before the one that writes the
response:

```csharp
builder.Services.AddExceptionHandler<ErrorLoggingHandler>();   // 1. log
builder.Services.AddExceptionHandler<ApiExceptionHandler>();   // 2. respond
```

```csharp
internal sealed partial class ErrorLoggingHandler(ILogger<ErrorLoggingHandler> logger) : IExceptionHandler
{
    public ValueTask<bool> TryHandleAsync(HttpContext http, Exception exception, CancellationToken ct)
    {
        var endpoint = http.GetEndpoint()?.DisplayName ?? http.Request.Path.Value ?? "unknown";

        switch (exception)
        {
            case OperationCanceledException when http.RequestAborted.IsCancellationRequested:
                LogClientAborted(endpoint);
                break;

            case ApiProblemException { StatusCode: < 500 } problem:
                LogClientProblem(endpoint, problem.StatusCode, problem.Title);
                break;

            default:
                LogUnexpected(exception, endpoint);
                break;
        }

        return ValueTask.FromResult(false);   // let the next handler write the response
    }

    [LoggerMessage(EventId = 5000, Level = LogLevel.Error, Message = "Unhandled exception in {Endpoint}")]
    private partial void LogUnexpected(Exception exception, string endpoint);

    [LoggerMessage(EventId = 5001, Level = LogLevel.Information,
        Message = "Request to {Endpoint} ended with {StatusCode}: {Title}")]
    private partial void LogClientProblem(string endpoint, int statusCode, string title);

    [LoggerMessage(EventId = 5002, Level = LogLevel.Debug, Message = "Client aborted request to {Endpoint}")]
    private partial void LogClientAborted(string endpoint);
}
```

The same team was very explicit about one thing: **the order of these registrations matters**, and
it should be documented right where it happens. If the responding handler comes first and returns
`true`, the logging handler never runs.

## Levels by category, not by "it's an exception"

The most important decision in error logging is the level. My mapping:

| Category | Example | Level | Why |
|---|---|---|---|
| Unexpected exception | `NullReferenceException`, DB timeout | `Error` | Someone needs to look at it |
| Downstream failure, handled | Retry exhausted against a partner API | `Warning` or `Error` | Depends on whether you can act on it |
| Security event | Unknown query parameters, invalid token storm | `Warning` with a fixed event ID | Alert on rate, not on each entry |
| Client error (4xx) | Not found, conflict, validation | `Information` (or `Debug`) | Expected behavior, useful for analysis |
| Client aborted | User closed the browser tab | `Debug` | Noise in almost every case |

A good test for your levels: **would you want to be woken up by this?** If the answer is no, it's not
`Error`. Alerts on error rates only work if errors are rare.

## Context that makes a log entry useful

A log entry that says "Unhandled exception" with a stack trace is the minimum. What makes it useful:

- **Trace and span ID.** With OpenTelemetry or Application Insights, these are attached
  automatically from `Activity.Current`. They connect the log entry to the request trace and to the
  `traceId` in the ProblemDetails response from the previous post.
- **The endpoint**, not just the path. `GET /orders/{id}` groups all orders; `/orders/4711` doesn't.
- **Business identifiers** as structured properties, via a logging scope set early in the request:

```csharp
using (logger.BeginScope(new Dictionary<string, object> { ["OrderId"] = command.OrderId }))
{
    await handler.HandleAsync(command, ct);
}
```

- **The exception's extension data.** If `ApiProblemException` carries `orderNumber`, put it into
  the log entry as a property too. Then you can search for all failures for one order.

Structured logging is the precondition for all of this: `{OrderId}` as a named placeholder, never
string interpolation. The `[LoggerMessage]` source generator enforces that and avoids boxing and
formatting costs when the level is disabled.

## What not to log

- **Request bodies by default.** They contain personal data, payment details and passwords.
  If you need them for debugging, log them in `Development` only, or redact them with
  `Microsoft.Extensions.Compliance.Redaction`.
- **Tokens and secrets**, including the `Authorization` header. HTTP logging middleware redacts it by
  default. Custom code doesn't.
- **Attacker-controlled values verbatim.** See the security filters post: names yes, raw values no.

## Pitfalls

**Logging in `catch` and then throwing.** The original sin. Remove the `catch`.

**Swallowing exceptions after logging.** The opposite mistake: `catch { logger.LogError(...); }` and
continue. The caller gets a success response for a failed operation. One codebase I worked on listed
exactly this as its "never do this" example.

**Background services.** `BackgroundService` exceptions don't go through the HTTP pipeline. Since
.NET 6, an unhandled exception in `ExecuteAsync` stops the host by default and is logged by the host.
Inside a processing loop, catch per item, log once, and continue.

**Sampling that drops errors.** Adaptive sampling in some telemetry SDKs can drop log entries under
load. Make sure exceptions and `Error` entries are excluded from sampling.

## How to test it

`Microsoft.Extensions.Diagnostics.Testing` has a `FakeLogger` that collects log records in memory,
so the logging behavior can be pinned down in an integration test:

```csharp
[TestMethod]
public async Task Not_found_is_logged_as_information_exactly_once()
{
    var collector = new FakeLogCollector();
    await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        b.ConfigureLogging(logging => logging.ClearProviders().AddProvider(new FakeLoggerProvider(collector))));

    using var client = factory.CreateClient();
    await client.GetAsync("/orders/999999");

    var entries = collector.GetSnapshot().Where(r => r.Id.Id is >= 5000 and < 5100).ToList();
    Assert.AreEqual(1, entries.Count);
    Assert.AreEqual(LogLevel.Information, entries[0].Level);
}
```

Add one for an unexpected exception (exactly one `Error`), and you'll notice immediately when an
upgrade or a new `catch` block starts duplicating entries.

In production, the metric that matters is **error log rate per endpoint**. If it's not near zero
during normal operation, either something is broken or your levels are wrong. Both are worth fixing.

## Summary

- **Separate error logging from error handling**: one component decides what the client sees, the
  other what operations sees.
- **Log once**, centrally, in an `IExceptionHandler` that logs and returns `false`, registered before
  the one that writes the response.
- Choose **levels by category**: unexpected → `Error`, client errors → `Information`, aborts →
  `Debug`, security events → `Warning` with a fixed event ID.
- Attach **trace IDs, the endpoint and business IDs** as structured properties, and use
  `[LoggerMessage]`.
- Never log **bodies, tokens or raw attacker input** by default.
- **Test** what ends up in the log, so duplicates and wrong levels can't creep back in.

*Previous: [Global error handling with ProblemDetails](/blog/2026-global-error-handling-with-problemdetails/) ·
Next: [Setting up Swagger / OpenAPI](/blog/2026-swagger-and-openapi-setup/)*
