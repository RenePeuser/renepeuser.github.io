---
title: Query providers and IDataReader — one data access API for many databases
date: 2026-11-23
authors: rene
tags: [dotnet, data-access, performance, architecture]
excerpt: When every tenant can live on a different database engine, provider-specific "if" statements spread through the whole codebase. A query provider hides connections, parameters, transactions and dialect differences behind one API, and going back to plain IDataReader can be faster than any micro-ORM.
---


Most applications talk to one database. Some don't. In one system I worked on, every customer
dataset pointed to its own connection, and those connections could be **MySQL or Snowflake**, with
more engines on the wish list. The same feature, say "export all orders of a region", had to run
against both.

Without a deliberate design, that requirement leaks into every query class: a little `if` for the
parameter prefix here, a different quoting rule there, a retry around the Snowflake call because
it goes over HTTP. After a while nobody can tell which part of a method is business logic and which
part is "make it work on engine B".

The team's answer was a **query provider**: one object per connection that you hand SQL and
parameters to, and that takes care of everything engine-specific. Along the way they also dropped
the micro-ORM underneath and went **back to the plain `IDataReader`**. This post shows the design
and why that last step paid off.

## The "before": the dialect leaks everywhere

```csharp
public async Task<IReadOnlyList<Order>> GetOrdersAsync(DbConnectionInfo info, string region, CancellationToken ct)
{
    using var connection = info.CreateConnection();

    var sql = info.Engine == DbEngine.Snowflake
        ? """SELECT "Id", "Total" FROM "Orders" WHERE "Region" = :region"""
        : "SELECT `Id`, `Total` FROM `Orders` WHERE `Region` = @region";

    var parameters = new DynamicParameters();
    parameters.Add(info.Engine == DbEngine.Snowflake ? ":region" : "@region", region);

    if (info.Engine == DbEngine.Snowflake)
        return (await retryPolicy.ExecuteAsync(() => connection.QueryAsync<Order>(sql, parameters))).ToList();

    return (await connection.QueryAsync<Order>(sql, parameters)).ToList();
}
```

Multiply that by a few hundred queries. Every new engine means touching all of them, and every
developer has to know every engine's quirks.

## The pattern: a query provider per connection

The idea is simple. The connection info doesn't hand out a raw `DbConnection` any more, it hands out
a **query provider** that already knows its engine:

```csharp
await using var queries = connectionInfo.GetQueryProvider();

var parameters = queries.CreateParameters();
parameters.Add("region", region);

var orders = await queries.QueryAsync(Sql.Orders.ByRegion, parameters, OrderMapper.Instance, ct);
```

Behind that call, one central pipeline does the same steps for every query, implemented once per
engine:

```mermaid
flowchart LR
    A[QueryAsync / ExecuteAsync] --> B[Resolve SQL<br/>engine-specific file?]
    B --> C[Prepare parameters<br/>prefix, NULL handling]
    C --> D[Log SQL<br/>debug only]
    D --> E[Execute<br/>retry if engine needs it]
    E --> F[Map rows<br/>IDataReader → T]
```

:::caution[Naming]
Don't call your interface `IQueryProvider`. `System.Linq.IQueryProvider` already exists and is
imported almost everywhere. I use `ISqlQueryProvider`.
:::

```csharp
public interface ISqlRunner
{
    Task<IReadOnlyList<T>> QueryAsync<T>(SqlText sql, IDbParameters? parameters, IRowMapper<T> mapper, CancellationToken ct);
    Task<T?> QueryFirstOrDefaultAsync<T>(SqlText sql, IDbParameters? parameters, IRowMapper<T> mapper, CancellationToken ct);
    Task<int> ExecuteAsync(SqlText sql, IDbParameters? parameters, CancellationToken ct);
    Task<T?> ExecuteScalarAsync<T>(SqlText sql, IDbParameters? parameters, CancellationToken ct);
}

public interface ISqlQueryProvider : ISqlRunner, IAsyncDisposable
{
    IDbParameters CreateParameters();
    Task<ISqlTransaction> BeginTransactionAsync(CancellationToken ct);
}

public interface ISqlTransaction : ISqlRunner, IAsyncDisposable
{
    Task CommitAsync(CancellationToken ct);
    Task RollbackAsync(CancellationToken ct);
}
```

## Back to IDataReader

Micro-ORMs like Dapper map rows to objects by generating IL at runtime, and they do it very well.
But they also make decisions for you: how parameters are expanded, how types are converted, which
return types are supported. With several engines and their drivers, those decisions don't always fit.
The team ran into trouble with dictionary-shaped results (`Dictionary<string, object>` per row) and
with how parameters were handled for one of the engines.

So they went one level down, to the API every ADO.NET driver implements: `DbCommand` and
`DbDataReader`. The mapping is a small class per result type:

```csharp
public interface IRowMapper<out T>
{
    void Initialize(DbDataReader reader);   // once per result set
    T Map(DbDataReader reader);             // once per row
}

public sealed class OrderMapper : IRowMapper<Order>
{
    public static readonly OrderMapper Instance = new();

    private int _id, _customerId, _total, _shippedAt;

    public void Initialize(DbDataReader reader)
    {
        _id         = reader.GetOrdinal("Id");
        _customerId = reader.GetOrdinal("CustomerId");
        _total      = reader.GetOrdinal("Total");
        _shippedAt  = reader.GetOrdinal("ShippedAt");
    }

    public Order Map(DbDataReader reader) => new(
        Id:         reader.GetInt64(_id),
        CustomerId: reader.GetInt64(_customerId),
        Total:      reader.GetDecimal(_total),
        ShippedAt:  reader.IsDBNull(_shippedAt) ? null : reader.GetDateTime(_shippedAt));
}
```

(Careful with a shared static instance: `Initialize` stores ordinals in fields, so either create a
mapper per query or keep the ordinals in a local struct. I keep it static here for brevity.)

The execution loop in the provider is the classic ADO.NET pattern:

```csharp
public async Task<IReadOnlyList<T>> QueryAsync<T>(
    SqlText sql, IDbParameters? parameters, IRowMapper<T> mapper, CancellationToken ct)
{
    await using var command = _connection.CreateCommand();
    command.CommandText = _dialect.Prepare(sql, parameters);
    parameters?.ApplyTo(command);

    await using var reader = await command.ExecuteReaderAsync(ct);

    var result = new List<T>();
    mapper.Initialize(reader);
    while (await reader.ReadAsync(ct))
        result.Add(mapper.Map(reader));

    return result;
}
```

Why this is fast:

- **Ordinals are resolved once** per result set, not per row and column.
- **Typed getters** (`GetInt64`, `GetDecimal`) avoid boxing. `reader["Total"]` or `GetValue` box
  every value.
- **No reflection, no runtime code generation**, no cache of mapping delegates, so it's also
  friendly to trimming and Native AOT.
- **Positional record construction.** The mapper calls the constructor directly.

After that change, the team's own BenchmarkDotNet suite measured fetching 1,000 objects from MySQL at
about **2.4 times the speed of Dapper**. Treat that as their result on their schema, not a universal
law, and measure on yours. Dapper is already fast. The gain comes from removing every bit of
generality you don't need.

The price is obvious: you write the mapper. For a handful of hot queries that's a good trade. For
hundreds of simple CRUD queries, a source generator that emits these mappers is the better
long-term answer.

## Parameters: let the provider create them

The second big lesson was about parameters. The old code accepted everything: Dapper's
`DynamicParameters`, dictionaries, anonymous types, records. Internally, they were converted back
and forth between these forms, and for every parameter the code had to figure out whether it was a
real SQL parameter, a `string.Format` placeholder or a `NULL`. For a data import with
hundreds of thousands of parameters, that adds up.

The fix: **parameters are created by the provider**, so they're in the right shape for the engine
from the start.

```csharp
public interface IDbParameters
{
    void Add(string name, object? value);
    void ApplyTo(DbCommand command);
}

internal sealed class MySqlParameters : IDbParameters
{
    private readonly List<(string Name, object? Value)> _items = [];

    public void Add(string name, object? value) =>
        _items.Add((name.TrimStart('@', ':'), value));

    public void ApplyTo(DbCommand command)
    {
        foreach (var (name, value) in _items)
        {
            var p = command.CreateParameter();
            p.ParameterName = "@" + name;
            p.Value = value ?? DBNull.Value;
            command.Parameters.Add(p);
        }
    }
}
```

The Snowflake implementation uses `:` as the prefix, and it handles `NULL` values separately,
because the team had problems with `NULL` passed as a bound parameter there. Callers don't know or
care. They call `parameters.Add("region", region)` and the right thing happens.

One thing the team **deliberately dropped**: passing a collection as a single parameter and letting
the library expand it into `IN (@p0, @p1, ...)` behind your back. It's convenient, and it rewrites
your SQL in ways that are hard to see. Instead, there's an explicit helper:

```csharp
public static string InList<T>(this IDbParameters parameters, string prefix, IReadOnlyCollection<T> values)
{
    var names = values.Select((value, i) =>
    {
        var name = $"{prefix}{i}";
        parameters.Add(name, value);
        return "@" + name;           // the dialect rewrites the prefix if needed
    });

    return $"({string.Join(", ", names)})";
}

// usage
var sql = $"SELECT Id, Total FROM Orders WHERE CustomerId IN {parameters.InList("c", customerIds)}";
```

It's explicit, and it makes huge `IN` lists visible in code review. Lists with thousands of values
are a performance problem in their own right, so chunk them or use a temporary table.

## Transactions you can see in the signature

With raw connections, whether a command runs inside a transaction depends on someone remembering to
pass `transaction:` to every call. The query provider makes that explicit: `BeginTransactionAsync`
returns an `ISqlTransaction`, which is itself an `ISqlRunner`. Commands that must take part in the
transaction **take it as a parameter**:

```csharp
public sealed record ReplaceRegionOrders(string Region, IReadOnlyList<OrderRow> Rows);

public sealed class ReplaceRegionOrdersHandler(IConnectionInfoProvider connections)
{
    public async Task HandleAsync(ReplaceRegionOrders command, CancellationToken ct)
    {
        await using var queries = (await connections.GetAsync(ct)).GetQueryProvider();
        await using var tx = await queries.BeginTransactionAsync(ct);

        await DeleteRegionAsync(tx, command.Region, ct);
        await InsertRowsAsync(tx, command.Rows, ct);

        await tx.CommitAsync(ct);   // DisposeAsync without commit rolls back
    }

    private static Task DeleteRegionAsync(ISqlRunner tx, string region, CancellationToken ct) { /* ... */ }
    private static Task InsertRowsAsync(ISqlRunner tx, IReadOnlyList<OrderRow> rows, CancellationToken ct) { /* ... */ }
}
```

A method that receives an `ISqlTransaction` (or at least an `ISqlRunner` from a transaction) is
visibly part of a unit of work. A method that opens its own connection visibly isn't.

## Engine-specific SQL files

Most SQL can be written to work on several engines. Some queries are worth optimizing per engine.
The convention the team used is small and effective: SQL lives in embedded `.sql` files, and a file
in a subfolder named after the engine overrides the generic one.

```text
Orders/
  ByRegion.sql            ← generic
  Snowflake/
    ByRegion.sql          ← used when the connection is Snowflake
```

```csharp
public SqlText Resolve(Assembly assembly, string name, DbEngine engine)
{
    var specific = $"{Path.GetDirectoryName(name)}/{engine}/{Path.GetFileName(name)}";
    return EmbeddedSql.TryLoad(assembly, specific) ?? EmbeddedSql.Load(assembly, name);
}
```

Pass the assembly explicitly (`typeof(OrderQueries).Assembly`). Resolving it implicitly with
`Assembly.GetCallingAssembly()` is slow and unreliable once the JIT inlines methods. The team
kept a benchmark for exactly that comparison in their suite.

## How it compares

| | Raw ADO.NET everywhere | Dapper | EF Core | Query provider + `IDataReader` |
|---|---|---|---|---|
| Hides engine differences | ❌ | ❌ | ✅ (if the engine has a provider) | ✅ |
| Hand-written SQL from DB experts | ✅ | ✅ | ⚠️ possible, not the main path | ✅ |
| Mapping effort | High, everywhere | None | None | One mapper per result type |
| Mapping speed | Fastest | Very fast | Fast | Fastest |
| Explicit transactions in signatures | ❌ | ❌ | ⚠️ via `DbContext` | ✅ |
| You own and maintain it | — | ❌ | ❌ | ✅ (that's a cost, too) |

## Pitfalls

**You're building a product.** A query provider is infrastructure that needs tests, documentation
and an owner. Don't build one for a single engine and a dozen queries. Dapper will do.

**Keep an escape hatch.** The team kept the old Dapper path available: if a query behaved
differently on the new provider and nobody knew why, you could switch that call back and compare.
That made the migration much less risky.

**Mappers drift from the schema.** A renamed column or a changed type fails at runtime, not at
compile time. Every query needs at least one integration test against a real database of each
engine it supports.

**Dialect differences don't disappear.** The provider handles prefixes, quoting, `NULL` and retries.
It doesn't make `GROUP_CONCAT` work on an engine that doesn't have it. Developers still have to know
which SQL runs where, which is what the engine-specific files are for.

**`SequentialAccess` and column order.** `CommandBehavior.SequentialAccess` is great for large BLOBs,
but then the mapper must read columns strictly in ordinal order. Use it only where it matters.

## How to keep it honest

- **Benchmarks in the repo.** A BenchmarkDotNet project that compares your mapper against Dapper on
  your real schemas. Run it when you change the pipeline. The team kept all of theirs reproducible in
  the shared solution.
- **Integration tests per engine.** [Testcontainers](https://dotnet.testcontainers.org/) for MySQL,
  PostgreSQL or SQL Server. For cloud-only engines like Snowflake, a dedicated test database and a
  nightly run.
- **An architecture test** that forbids `DbConnection.CreateCommand` and `using Dapper` outside the
  data-access assembly, so the provider stays the only way in. See
  [self-defending codebases](/blog/2026-self-defending-codebases/).

## Summary

- When connections can point to **different database engines**, a **query provider per connection**
  keeps engine quirks out of your business code.
- Run every query through **one pipeline**: resolve SQL, prepare parameters, log, execute with
  engine-specific retries, map.
- **Plain `IDataReader`** with ordinals resolved once and typed getters can beat a micro-ORM, but
  you write the mappers. Measure on your schema.
- Let the **provider create parameters**, make `IN` lists explicit, and pass **transactions as
  parameters** so they're visible.
- It's infrastructure you own: keep an **escape hatch**, **integration tests per engine** and
  **benchmarks** in the repo.
