---
title: Filtering Application Insights telemetry without losing the signal
date: 2026-11-23
authors: rene
tags: [observability, aspnetcore]
excerpt: An API with no users produced thousands of telemetry items in a few days, all health checks and Always On pings. How to filter that noise with telemetry processors or OpenTelemetry, why "Contains" is the wrong match, and how to test that your filter drops only what it should.
---


In one project I worked on, a freshly deployed API had collected about **16,000 telemetry items in
three days**. Not a single real user had called it yet. Everything was noise: health checks, the
App Service *Always On* ping, `favicon.ico`, `robots.txt`, verbose framework traces. Every one of those
items costs ingestion money, and worse, it buries the requests you actually care about when you're
looking for them during an incident.

Filtering telemetry is easy. Filtering it **correctly** is where teams get hurt: the filter that drops
health checks also drops half of the real traffic, and nobody notices because, well, the data that
would tell you is gone. This post covers both the classic Application Insights SDK and OpenTelemetry,
and how to test the filter.

## Where the noise comes from

| Source | What you see | Typical volume |
|---|---|---|
| App Service *Always On* | `GET /` every few minutes per instance | constant, forever |
| Health checks (App Service, load balancer, Kubernetes probes) | `GET /health` every few seconds to a minute | constant, per instance |
| Browsers and crawlers | `favicon.ico`, `robots.txt` | sporadic |
| Framework logs | `Information` traces from `Microsoft.AspNetCore.*` per request | proportional to traffic |
| Expected failures | 404 from a downstream "does it exist?" lookup | proportional to traffic |

If you see a `GET` request every five minutes in an otherwise idle app, that's *Always On*. It keeps
the app warm by requesting the root URL. That's a good feature, but it doesn't need to be in your
telemetry.

## The first attempt: a list of names and `Contains`

The setup I found in that project, and in several others since, looked like this:

```csharp
internal sealed class RequestTelemetryFilter(ITelemetryProcessor next) : ITelemetryProcessor
{
    private static readonly string[] Names =
        ["favicon.ico", "robots", "/health", "health", "GET /", "GetHealthStatus"];

    public void Process(ITelemetry item)
    {
        if (item is RequestTelemetry request &&
            Names.Any(n => request.Name.Contains(n, StringComparison.OrdinalIgnoreCase)))
        {
            return;   // dropped
        }

        next.Process(item);
    }
}
```

Plus the same class again for traces, and again for events. It works, and it has two problems:

- **`Contains` matches far too much.** `"health"` also matches `GET /customers/{id}/health-insurance`.
  And `"GET /"` matches *every* GET request whose name is a route template, which is what minimal APIs
  and newer SDK versions produce (`GET /orders/{id}`). Depending on how your request names look, that
  single entry silently drops all your read traffic.
- **The request name isn't the right thing to look at.** The name is derived from routing and can
  change with an SDK update. The URL path and the user agent are stable.

The same project also had a good idea worth keeping: a **dependency** that returns 404 for a known
"does this exist?" call was not dropped, but **marked as successful**. It still shows up in the
transaction view, it just doesn't count as a failure anymore.

## The better version: one processor, exact rules, configured

```csharp
public sealed class TelemetryNoiseOptions
{
    public string[] IgnoredPaths { get; set; } = ["/health", "/health/ready", "/favicon.ico", "/robots.txt"];
    public string[] IgnoredUserAgents { get; set; } = ["AlwaysOn"];
    public string[] ExpectedNotFoundHosts { get; set; } = [];
}

public sealed class TelemetryNoiseFilter(
    ITelemetryProcessor next,
    IOptions<TelemetryNoiseOptions> options) : ITelemetryProcessor
{
    private readonly TelemetryNoiseOptions _options = options.Value;

    public void Process(ITelemetry item)
    {
        switch (item)
        {
            case RequestTelemetry request when IsNoise(request):
                return;

            case DependencyTelemetry { ResultCode: "404" } dependency
                when _options.ExpectedNotFoundHosts.Contains(dependency.Target, StringComparer.OrdinalIgnoreCase):
                dependency.Success = true;   // keep it, but it's not a failure
                break;
        }

        next.Process(item);
    }

    private bool IsNoise(RequestTelemetry request)
    {
        if (request.Url is { } url &&
            _options.IgnoredPaths.Any(p => string.Equals(url.AbsolutePath, p, StringComparison.OrdinalIgnoreCase)))
        {
            return request.Success != false;   // keep failing health checks!
        }

        return request.Context.User.UserAgent is { } ua &&
               _options.IgnoredUserAgents.Any(a => ua.StartsWith(a, StringComparison.OrdinalIgnoreCase));
    }
}
```

```csharp
builder.Services.AddApplicationInsightsTelemetry();
builder.Services.Configure<TelemetryNoiseOptions>(builder.Configuration.GetSection("TelemetryNoise"));
builder.Services.AddApplicationInsightsTelemetryProcessor<TelemetryNoiseFilter>();
```

Three decisions in there that I'd defend in any review:

1. **Exact path match, not `Contains`.** If you need a prefix, use `StartsWith` on whole segments.
2. **Failing health checks are kept.** A health check that returns 503 is exactly the signal you want
   when the app is in trouble. Drop the boring successes, keep the failures.
3. **The user agent of the request is not on `RequestTelemetry` by default.** To filter on it, add a
   small `ITelemetryInitializer` that copies `User-Agent` from `HttpContext` onto
   `request.Context.User.UserAgent`, or filter Always On by its path (`/`) if your app doesn't serve
   anything there.

## Traces: use log levels, not a processor

The original setup filtered **traces** by searching the message text for "health". Don't. Logs have a
filter mechanism built in: categories and levels. Most of the per-request trace noise comes from
framework categories, and one configuration block removes it:

```json
{
  "Logging": {
    "ApplicationInsights": {
      "LogLevel": {
        "Default": "Information",
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.AspNetCore.Diagnostics.HealthChecks": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    }
  }
}
```

That's cheaper (the log entry is never created) and it can be changed per environment without a
deployment.

## And with OpenTelemetry?

Many new projects use the Azure Monitor OpenTelemetry distro (`Azure.Monitor.OpenTelemetry.AspNetCore`)
instead of the classic SDK, and the 3.x Application Insights SDK is built on OpenTelemetry as well.
There, `ITelemetryProcessor` doesn't exist. You filter at the instrumentation level, **before** the
activity is even recorded:

```csharp
builder.Services.AddOpenTelemetry()
    .UseAzureMonitor()
    .WithTracing(tracing => tracing
        .AddProcessor<ExpectedNotFoundProcessor>());

builder.Services.Configure<AspNetCoreTraceInstrumentationOptions>(o =>
{
    o.Filter = ctx => !TelemetryNoise.IsNoise(ctx.Request);
});

builder.Logging.AddFilter<OpenTelemetryLoggerProvider>("Microsoft.AspNetCore", LogLevel.Warning);
```

```csharp
public static class TelemetryNoise
{
    private static readonly PathString[] IgnoredPaths = ["/health", "/favicon.ico", "/robots.txt"];

    public static bool IsNoise(HttpRequest request) =>
        IgnoredPaths.Any(p => request.Path.Equals(p, StringComparison.OrdinalIgnoreCase)) ||
        request.Headers.UserAgent.ToString().StartsWith("AlwaysOn", StringComparison.OrdinalIgnoreCase);
}
```

The ASP.NET Core filter runs before the response exists, so you can't keep only *failing* health checks
there. If that matters to you, keep the health endpoint in tracing and lower its volume with sampling
instead, or rely on the health check's own logs (which you kept at `Warning`).

For the dependency case, a small processor on `OnEnd` does what `dependency.Success = true` did:

```csharp
public sealed class ExpectedNotFoundProcessor : BaseProcessor<Activity>
{
    public override void OnEnd(Activity activity)
    {
        if (activity.Kind == ActivityKind.Client &&
            activity.GetTagItem("http.response.status_code") is 404 &&
            activity.GetTagItem("server.address") is "catalog.example.com")
        {
            activity.SetStatus(ActivityStatusCode.Unset);   // not an error
        }
    }
}
```

## Filtering vs. sampling

| | Filtering | Sampling |
|---|---|---|
| What it removes | Specific, known-useless items | A percentage of everything |
| Keeps full transactions | yes | yes (sampling is per operation) |
| Effect on counts | Those items are gone | Use `sum(itemCount)` to correct |
| Good for | Health checks, pings, expected 404s | High-volume real traffic |

Do both: filter the known noise first, then sample what's left if the volume is still too high. Never
use sampling to hide noise. It removes your real data at the same rate.

## Pitfalls

- **Substring matching.** The most common bug. Match paths exactly.
- **Dropping failures.** A filter on "health" that drops a 503 from the health endpoint hides the one
  signal that the app is down.
- **One processor per telemetry type, each with its own copy of the list.** They drift. One processor,
  one configuration section.
- **Logging "around" the filter.** The original codebase also had a MediatR logging behavior that wrote
  custom telemetry for every query, including the health check query. Telemetry processors only see
  what reaches the pipeline, so the behavior needed its own exclusion and its own test.
- **No way to check.** If the filter is wrong, the evidence is filtered too.

## Test the filter

Write tests for it. A telemetry filter is the one piece of code whose bugs are invisible by design.
Telemetry processors are easy to unit test with a capturing "next":

```csharp
public sealed class CapturingProcessor : ITelemetryProcessor
{
    public List<ITelemetry> Items { get; } = [];
    public void Process(ITelemetry item) => Items.Add(item);
}

[TestClass]
public sealed class TelemetryNoiseFilterTests
{
    private readonly CapturingProcessor _sink = new();
    private TelemetryNoiseFilter CreateFilter() =>
        new(_sink, Options.Create(new TelemetryNoiseOptions()));

    [TestMethod]
    [DataRow("https://shop.example.com/health", true, false)]
    [DataRow("https://shop.example.com/health", false, true)]     // failing health check is kept
    [DataRow("https://shop.example.com/customers/7/health-insurance", true, true)]
    [DataRow("https://shop.example.com/orders/42", true, true)]
    public void Filters_only_noise(string url, bool success, bool expectedKept)
    {
        var request = new RequestTelemetry { Url = new Uri(url), Success = success, Name = "GET " + new Uri(url).AbsolutePath };

        CreateFilter().Process(request);

        Assert.AreEqual(expectedKept, _sink.Items.Contains(request));
    }
}
```

The `health-insurance` and `orders/42` rows are the important ones. They're the regression tests for the
`Contains` bug. For the OpenTelemetry version, test `TelemetryNoise.IsNoise` the same way with a
`DefaultHttpContext`.

Then measure in production. This query shows what's still filling your workspace:

```kusto
union requests, dependencies, traces
| where timestamp > ago(3d)
| summarize Items = sum(itemCount) by itemType, Name = coalesce(name, substring(message, 0, 80))
| top 20 by Items desc
```

Run it before and after the filter. The top of that list should change, and your real endpoints should
still be there.

## Summary

- An idle app can produce thousands of telemetry items a day from **health checks, Always On and
  framework logs**.
- Filter with **one processor and exact rules** (path, user agent), not a list of substrings.
- **Keep failing health checks** and mark expected downstream 404s as success instead of dropping them.
- Reduce trace noise with **log levels per category**, not by searching message text.
- With **OpenTelemetry**, filter in the instrumentation options and adjust status in a processor.
- **Unit test the filter**, including the URLs it must *not* drop, and check the top talkers with KQL.
