---
title: The KQL features I actually use every week
date: 2026-11-23
authors: rene
tags: [observability, azure]
excerpt: KQL has hundreds of operators and functions. A dozen of them cover almost every incident. The operators, functions and let tricks I reach for most, plus a complete health-check query and the integer-division bug hiding in it.
---


The KQL reference lists hundreds of operators and functions. In practice, I use about a dozen of them
in almost every query, and a few more every couple of weeks. When one team I worked with wrote their
internal KQL guide, they ended up with the same short list. This post is my version of it, with real
query patterns instead of a list of links.

If the basics (pipes, `let`, the data model of Application Insights) are new to you, start with
[KQL fundamentals for .NET developers](/blog/2026-kql-fundamentals/). I'll use the classic Application
Insights table names (`requests`, `dependencies`, `exceptions`, `traces`) throughout.

## The tabular operators

These take a table and return a table. Eight of them carry almost everything.

### `where`, `project`, `extend`

```kusto
requests
| where timestamp > ago(1h) and success == false
| extend Endpoint = tostring(split(name, " ")[1])
| project timestamp, Endpoint, resultCode, duration, operation_Id
```

- `where` filters rows (SQL `WHERE`).
- `extend` **adds** columns and keeps all others.
- `project` defines the **complete** set of columns (SQL `SELECT`).

`project` has useful siblings: `project-away` removes columns, `project-keep` keeps a set (with
wildcards), `project-rename` renames, and `project-reorder` moves columns to the front without dropping
the rest. For a quick exploratory query, `project-away customDimensions, customMeasurements` is often
nicer than listing twenty columns you want to keep.

### `summarize` and `bin()`

`summarize` is `GROUP BY`. Combined with `bin()`, it turns events into time series:

```kusto
requests
| where timestamp > ago(24h)
| summarize Requests = count(),
            Failed   = countif(success == false),
            P95      = percentile(duration, 95)
         by bin(timestamp, 15m), cloud_RoleName
| render timechart
```

`bin(timestamp, 15m)` rounds every timestamp down to its 15-minute bucket. `render timechart` turns
the result into a chart in the portal. Aggregations I use constantly: `count()`, `countif()`,
`dcount()` (distinct count, approximate and fast), `sum()`, `avg()`, `min()`, `max()`,
`percentile()`/`percentiles()`, `arg_max()` and `make_set()`.

`arg_max()` deserves its own mention. It returns the **whole row** with the maximum value, which
solves the "latest record per key" problem in one line:

```kusto
customEvents
| where name == "OrderStatusChanged"
| summarize arg_max(timestamp, *) by OrderId = tostring(customDimensions.OrderId)
```

### `join` and `union`

`join` combines tables horizontally, `union` vertically.

```kusto
let window = 1h;
exceptions
| where timestamp > ago(window)
| join kind=inner (
    requests
    | where timestamp > ago(window)
    | project id, Endpoint = name, resultCode
  ) on $left.operation_ParentId == $right.id
| summarize Count = count() by Endpoint, type
| top 10 by Count
```

Two things that bite people:

- **The default join kind is `innerunique`**, which de-duplicates the left side first. That silently
  drops rows if the left key isn't unique. Always write the kind explicitly (`inner`, `leftouter`,
  `leftanti`...), so the next reader knows what you meant.
- **Put the smaller table on the left.** Kusto broadcasts the left side, so the order matters for
  performance.

`union` is what I use to search across tables during an incident:

```kusto
union requests, dependencies, exceptions, traces
| where operation_Id == "4bf92f3577b34da6a3ce929d0e0e4736"
| project timestamp, itemType, name, message, type, resultCode, duration
| order by timestamp asc
```

That's the "show me everything that happened in this operation" query. It's worth having saved.

### `distinct`, `sort`, `take`, `top`

- `distinct cloud_RoleName, resultCode` returns unique combinations.
- `sort by` / `order by` sort (they're aliases). Default is **descending**, not ascending like SQL.
- `take 20` returns any 20 rows, unordered. Great for "what does this table look like?"
- `top 10 by duration` is `sort` and `take` in one, and cheaper than the two separately.

## The scalar side

### Comparisons

- `in` / `!in` for lists: `resultCode in ("500", "502", "503")`. Use `in~` for case-insensitive.
- `between`: `duration between (1000 .. 5000)` (in the classic schema, `duration` is milliseconds) or `timestamp between (datetime(2026-11-01) .. 1d)`.
- Datetime arithmetic just works: `now() - 7d`, `timestamp + 2h`, `datetime_diff('minute', a, b)`.

### Strings

```kusto
traces
| where message has "timeout"                      // term match, uses the index
| where message !has "health"                      // negation
| where message matches regex @"order \d{6,}"     // when you really need a regex
| extend Tenant = extract(@"tenant=(\w+)", 1, message)
```

Prefer `has`, `startswith` and `==` over `contains` and regex. They're faster because they can use the
term index. Use `extract()` for one value and `parse` when a message has a fixed shape:

```kusto
traces
| where message startswith "Imported "
| parse message with "Imported " Count:int " products from " Source " in " DurationMs:long "ms"
| summarize avg(DurationMs) by Source
```

### `iif`, `case`, `coalesce`, `isempty`

```kusto
requests
| extend Bucket = case(duration < 200, "fast",
                       duration < 1000, "ok",
                       "slow")
| extend Tenant = coalesce(tostring(customDimensions.Tenant), "unknown")
```

### Exception details: `Details[0]` vs. `Details[-1]`

An exception in Application Insights has a `details` array: index `0` is the outer exception, the
next entries are the inner exceptions, and `-1` is the innermost. The innermost one is usually the
real cause, while the outer one is your wrapper:

```kusto
exceptions
| where timestamp > ago(1d)
| extend InnermostType    = tostring(details[-1].type),
         InnermostMessage = tostring(details[-1].message)
| summarize Count = count() by outerType, InnermostType, InnermostMessage
| order by Count desc
```

In the workspace schema (`AppExceptions`), Azure already precomputes `OuterType`, `InnermostType`,
`OuterMessage` and `InnermostMessage` for you.

## `let`: variables, tables and functions

`let` is what turns a query into something maintainable. It can hold a scalar, a query, a literal
table or a function.

```kusto
let window = 6h;                                                  // scalar
let failedRequests = requests                                     // query
    | where timestamp > ago(window) and success == false;
let statusNames = datatable(resultCode:string, StatusName:string) // literal table
[
    "400", "Bad Request",
    "401", "Unauthorized",
    "403", "Forbidden",
    "404", "Not Found",
    "500", "Internal Server Error",
    "503", "Service Unavailable"
];
failedRequests
| summarize Count = count() by resultCode
| join kind=leftouter statusNames on resultCode
| project resultCode, StatusName, Count
```

User-defined functions are lambdas. There's no `return`, the last expression is the result:

```kusto
let isBusinessHours = (t:datetime)
{
    let local = datetime_utc_to_local(t, "Europe/Berlin");
    dayofweek(local) between (1d .. 5d) and hourofday(local) between (8 .. 17)
};
requests
| where timestamp > ago(7d)
| summarize count() by InBusinessHours = isBusinessHours(timestamp)
```

`datetime_utc_to_local()` handles daylight saving time for you. That's much better than adding a fixed
`+1h`, which is wrong half the year.

## `materialize()`: compute once, use many times

If you reference the same `let` query several times, Kusto may evaluate it several times.
`materialize()` caches the result for the duration of the query. That's what makes the following
pattern cheap.

## A complete example: a CPU health check

This is the kind of query that ends up in an alert rule or a dashboard tile. It computes three CPU
indicators over the last 90 minutes and returns one row per indicator, but only if at least one
indicator is bad. It's based on a query from that team's guide. While adapting it I tripped over a classic, more on
that below.

```kusto
let window = 90m;
let overloadPctThreshold = 5.0;     // at 100% CPU for at most 5% of the time
let avgPctThreshold = 60.0;         // average CPU at most 60%
let p80PctThreshold = 80.0;         // the worst 20% of samples are all above this
//
let stats = materialize(
    performanceCounters
    | where timestamp > ago(window)
    | where name == "% Processor Time Normalized"
    | summarize OverloadPct = round(100.0 * countif(value >= 100) / count(), 1),
                AvgPct      = round(avg(value), 1),
                P80Pct      = round(percentile(value, 80), 1)
    | extend BadOverload = OverloadPct > overloadPctThreshold,
             BadAvg      = AvgPct > avgPctThreshold,
             BadP80      = P80Pct > p80PctThreshold
    | extend AnyBad = BadOverload or BadAvg or BadP80
);
//
union
    (stats | project AnyBad, Order = 0, What = "Time at 100% CPU",         Value = OverloadPct, Threshold = overloadPctThreshold, IsBad = BadOverload),
    (stats | project AnyBad, Order = 1, What = "Average CPU",              Value = AvgPct,      Threshold = avgPctThreshold,      IsBad = BadAvg),
    (stats | project AnyBad, Order = 2, What = "80th percentile CPU",      Value = P80Pct,      Threshold = p80PctThreshold,      IsBad = BadP80)
| where AnyBad
| order by Order asc
| project What, Value = strcat(Value, "%"), Threshold = strcat(Threshold, "%"), Flag = iif(IsBad, "!", "")
```

The classic: computing the overload share as `countif(value >= 100) / count()`. Both
functions return `long`, so that's **integer division**, and the result is `0` for every value below
100%. The alert could never fire on that indicator. Multiplying by `100.0` first makes it a real
number and an actual percentage. It's the same trap as `int / int` in C#, and just as easy to miss
in review.

Note the comment-only `//` lines: they separate the sections visually without ending the query the
way a blank line would.

## Cheat sheet

| I want to... | Use |
|---|---|
| Filter rows | `where` |
| Add a column | `extend` |
| Pick columns | `project`, `project-away`, `project-reorder` |
| Group and aggregate | `summarize ... by` |
| Time series | `summarize ... by bin(timestamp, 5m)` + `render timechart` |
| Latest row per key | `summarize arg_max(timestamp, *) by Key` |
| Combine tables side by side | `join kind=...` |
| Search across tables | `union` |
| Top N | `top N by Column` |
| Parse a fixed-format message | `parse` |
| Extract one value | `extract()` |
| Reuse a subquery | `let` + `materialize()` |
| Lookup table | `datatable()` |

## Pitfalls

- **`sort` defaults to descending.** Write `asc` or `desc` explicitly, every time.
- **`innerunique` joins.** The default join drops rows silently. Always specify `kind=`.
- **Integer division.** `countif() / count()` is integer division. Multiply by `100.0` first.
- **`take` is not deterministic.** Two runs return different rows. Use `top` if order matters.
- **`count()` with sampling.** With adaptive sampling, use `sum(itemCount)` to get real numbers.

## How to keep queries correct

Queries are code. Put the ones you use for alerts and dashboards in the repository, review them in
pull requests, and run them against a test environment after a change. In the
[next posts](/blog/2026-kql-in-azure-alert-rules/) I'll show how those same queries end up in alert
rules and Grafana dashboards.

## Summary

- Eight tabular operators (`where`, `extend`, `project`, `summarize`, `join`, `union`, `top`, `distinct`)
  cover most queries.
- `bin()` + `render timechart` turns events into charts. `arg_max()` gets the latest row per key.
- Prefer **`has`** and `parse` over `contains` and regex.
- Use **`let`** for variables, lookup tables and functions, and **`materialize()`** when you reuse a
  subquery.
- Watch out for **integer division**, **default descending sort** and **`innerunique` joins**.
