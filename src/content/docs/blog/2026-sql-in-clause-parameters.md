---
title: SQL IN clauses with thousands of parameters
date: 2026-11-23
authors: rene
tags: [dotnet, data-access, performance]
excerpt: WHERE Id IN (@p0, @p1, … @p1224) works fine in the test with ten IDs and times out in production with twelve hundred. Hard parameter limits per database, why large IN lists get slow long before that, and the better options, from batching to table-valued parameters, JSON and arrays.
---

:::note[Series]
Part of the series [*.NET pitfalls*](/series/dotnet-pitfalls/).
:::

Almost every data-access layer has a method like this somewhere:

```csharp
public Task<IEnumerable<ResourceAccess>> GetAccessAsync(IReadOnlyCollection<long> resourceIds) =>
    connection.QueryAsync<ResourceAccess>(
        "SELECT ... FROM Resource r ... WHERE r.Id IN @resourceIds",
        new { resourceIds });
```

Dapper expands `IN @resourceIds` into `IN (@resourceIds1, @resourceIds2, ...)`. EF Core does
something similar for `ids.Contains(x.Id)`. With ten IDs in the test database, it's fast. Then a
real user with real data comes along.

## A story with numbers

In one codebase I worked on, a user reported errors on a permissions screen. The request ran into a
timeout and the connection was cut after 30 seconds. The query behind it was a join over resources,
roles and access policies, with a `WHERE r.Id IN (...)` at the end. For that user, the list contained
**1,225 parameters**.

The quick fix was to split the list into chunks of 100 and run the chunks separately:

```csharp
var chunks = resourceIds.Chunk(100);
var results = await Task.WhenAll(chunks.Select(ids => repository.GetAccessAsync(request, ids)));
var all = results.SelectMany(r => r).ToList();
```

Instead of one query, there were now 13 smaller ones. The total time went from about **40 seconds to
about 4.3 seconds**. The documented follow-ups were the ones you'd expect: check the indexes, keep
batching, and look at joins or temporary tables instead of large IN lists.

That's a factor of nine from a five-line change. Why?

## Why large IN lists hurt

**Hard limits.** Every database and driver has a maximum number of parameters per statement:

| Database | Limit | What happens |
|---|---|---|
| SQL Server | 2,100 parameters per request | Error: *"The incoming request has too many parameters"* |
| MySQL / MariaDB | 65,535 placeholders per prepared statement | Error, though performance degrades far earlier |
| PostgreSQL (Npgsql) | 65,535 parameters | Error, though `= ANY(@array)` makes the limit irrelevant |
| Oracle | 1,000 expressions in a literal IN list | ORA-01795 |
| SQLite | 32,766 variables by default (since 3.32) | Error |

**Soft limits, which hit much earlier.**

- **Parsing and planning.** Every parameter is part of the statement text. The optimizer has to parse
  and estimate a predicate with 1,225 alternatives, and its cardinality estimates get worse with every
  value. For complex queries with joins, that can lead to a plan that scans instead of seeks.
- **Plan cache pollution.** `IN (@p0..@p9)` and `IN (@p0..@p10)` are different statements with different
  cached plans. A list whose length varies per user produces hundreds of nearly identical plans, which
  evict useful ones.
- **Round trip size.** A statement with thousands of parameters is a big network packet, and each
  parameter has metadata.

The documentation in that codebase put it pragmatically: performance can degrade from roughly 1,000
items, and above 100 to 1,000 items it's worth looking for an alternative. That matches my experience
across databases. The exact number depends on the query; the pattern doesn't.

## Option 1: batching

Splitting into chunks is the quickest fix and works with every database and every data-access library.
`Enumerable.Chunk` is built in since .NET 6.

Things to get right:

- **Connections.** Running chunks in parallel with `Task.WhenAll` requires each chunk to use **its own
  connection** (or its own `DbContext`). A single `DbConnection` or `DbContext` doesn't support
  concurrent commands.
- **Bounded parallelism.** Thirteen chunks are fine. Thirteen hundred are a self-inflicted load test.
  Use `Parallel.ForEachAsync` with a `MaxDegreeOfParallelism`, or just run them sequentially.
- **Consistency.** Chunks run as separate queries, possibly seeing different data. For reads like
  permissions that's usually acceptable. For anything that needs a consistent snapshot, run the chunks in
  one transaction or use one of the options below.
- **Fixed chunk sizes** keep the plan cache small: with a size of 100, there are at most two statement
  shapes (100 and the remainder), and you can pad the last chunk with a repeated ID to get just one.

## Option 2: pass the list as one parameter

The better fix is to send the whole list as **a single parameter** and let the database turn it into a
table it can join against. Every major database has a way to do that.

**SQL Server: table-valued parameters.** Define a table type once, then pass a `DataTable` or
`IEnumerable<SqlDataRecord>`:

```sql
CREATE TYPE dbo.IdList AS TABLE (Id bigint NOT NULL PRIMARY KEY);
```

```csharp
var table = new DataTable();
table.Columns.Add("Id", typeof(long));
foreach (var id in resourceIds.Distinct())
    table.Rows.Add(id);

var rows = await connection.QueryAsync<ResourceAccess>(
    """
    SELECT r.Id, ...
    FROM @ids AS i
    JOIN dbo.Resource AS r ON r.Id = i.Id
    ...
    """,
    new { ids = table.AsTableValuedParameter("dbo.IdList") });
```

The primary key on the table type gives the optimizer a unique, indexed set to join against.

**SQL Server without a table type: JSON or STRING_SPLIT.**

```sql
SELECT r.Id, ...
FROM dbo.Resource AS r
WHERE r.Id IN (SELECT CAST([value] AS bigint) FROM OPENJSON(@idsJson));
```

```csharp
new { idsJson = JsonSerializer.Serialize(resourceIds) }
```

`STRING_SPLIT(@ids, ',')` works too (SQL Server 2016+). Both use one statement shape regardless of the
list length, so there's one cached plan.

**PostgreSQL: arrays.** The simplest of all, because Npgsql maps .NET arrays to PostgreSQL arrays:

```csharp
var rows = await connection.QueryAsync<ResourceAccess>(
    "SELECT ... FROM resource r WHERE r.id = ANY(@ids)",
    new { ids = resourceIds.ToArray() });
```

**MySQL 8: JSON_TABLE.**

```sql
SELECT r.Id, ...
FROM Resource r
JOIN JSON_TABLE(@idsJson, '$[*]' COLUMNS (Id BIGINT PATH '$')) AS ids ON ids.Id = r.Id;
```

**Any database: a temporary table.** Bulk-insert the IDs into a temp table (with `SqlBulkCopy`,
`MySqlBulkCopy` or `COPY` for PostgreSQL), then join. That's the most work, and it's the best option
for really large sets (tens of thousands of IDs) or when the same set is used by several queries.

## What EF Core does for you

EF Core's translation of `ids.Contains(x.Id)` has changed several times, so it's worth knowing which
version you're on:

- **Up to EF Core 7**, the values were inlined as **constants** into the SQL. No parameter limit, but a new
  plan for every distinct list.
- **EF Core 8** switched to sending the list as **one parameter**: a JSON array unpacked with `OPENJSON` on
  SQL Server and `json_each` on SQLite, and a native array on PostgreSQL. One plan, no limit. On some
  databases this made the optimizer's estimates worse, because it no longer sees the values.
- **EF Core 10** changed the default again for providers where that's beneficial: the list is expanded into
  **individual parameters**, padded to a few fixed sizes to limit plan-cache bloat. You can override the
  translation per query with `EF.Parameter(ids)` or `EF.Constant(ids)`, and globally in the provider
  options.

If you hit a performance problem with `Contains` after an EF Core upgrade, look at the generated SQL first.
It may not be the SQL you remember.

## Or: don't send the IDs at all

Often the list of IDs came out of the database a moment earlier. In the story above, the IDs were the
resources a user could see. If you can express *how* you got the IDs as part of the query (a join, a
subquery, an `EXISTS`), the database never needs the list at all:

```sql
-- instead of first loading the IDs and then sending them back
SELECT r.Id, ...
FROM Resource r
JOIN UserVisibleResources v ON v.ResourceId = r.Id AND v.UserId = @userId;
```

That's the cleanest fix, and the one to check first.

## Comparison

| Option | Statement shapes / plans | Works for | Effort |
|---|---|---|---|
| Large IN list | One per list length | Small lists only (tens, maybe a few hundred) | None |
| Batching (fixed chunk size) | One or two | Any database, any library | Low |
| TVP (SQL Server) | One | Any size, indexed join | Medium (table type) |
| JSON / `STRING_SPLIT` / `JSON_TABLE` | One | Medium-sized lists | Low |
| PostgreSQL `= ANY(@array)` | One | Any size | Very low |
| Temp table + bulk insert | One | Very large sets, reused sets | High |
| Join / subquery instead of IDs | One | When the IDs come from the database anyway | Depends |

## Find them before your users do

- **Test with realistic sizes.** An integration test that calls the repository with 5,000 IDs catches both
  the hard limit and the timeout. It takes seconds to write.
- **Guard in code.** If a method has a known safe maximum, enforce it, so the failure is explicit:
  `ArgumentOutOfRangeException.ThrowIfGreaterThan(ids.Count, 1_000);` combined with batching in the caller.
- **Telemetry.** Database spans in OpenTelemetry include the statement duration. A query whose duration
  grows with the user's data is a candidate. On SQL Server, Query Store shows near-duplicate statements
  that differ only in their parameter count.

## Summary

- Large IN lists hit **hard parameter limits** (2,100 on SQL Server) and get **slow long before that** because
  of parsing, estimates and plan-cache pollution.
- **Batching** with a fixed chunk size is the quick fix. In one case, 13 chunks of 100 instead of 1,225
  parameters took a query from about 40 s to about 4.3 s. Use separate connections and bounded
  parallelism.
- Better: pass the list as **one parameter**: TVPs or `OPENJSON` on SQL Server, arrays on PostgreSQL,
  `JSON_TABLE` on MySQL, or a temp table for very large sets.
- Know what your **EF Core version** generates for `Contains`. It changed in 8 and again in 10.
- Best: **don't round-trip the IDs** when the database can compute them itself.
