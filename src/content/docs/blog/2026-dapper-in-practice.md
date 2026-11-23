---
title: Dapper in practice — when SQL is the source of truth
date: 2026-11-23
authors: rene
tags: [dotnet, data-access]
excerpt: When database experts hand you hand-tuned SQL, translating it to LINQ and back is pure overhead. Why some teams pick Dapper over EF Core, how to use it properly in modern C#, and the four mistakes that show up again and again (materialization errors, IN lists, TransactionScope and missing cancellation).
---

:::note[Series]
Part of the series [*Caching & data*](/series/caching-and-data/).
:::

"Here's the query, it runs in 80 ms on the production data. Can you put it behind the endpoint?"

In one team I worked with, that was the normal workflow. SQL specialists wrote and tuned the queries
for a large analytical database, and the developers built the API around them. With EF Core, that
meant translating a 60-line SQL statement with CTEs and window functions into LINQ, checking whether
the generated SQL was anywhere near the original, and when something was wrong, translating it
**back** so the specialists could look at it.

The team decided against EF Core for that service, and wrote the reasons down. They were good
reasons, and they still apply in 2026 to a certain kind of system. This post is about that decision,
and about using Dapper well once you've made it.

## Why not EF Core (here)

The team's reasons, in short:

1. **SQL is the source of truth.** If the experts deliver SQL, the shortest path is to run that SQL.
   Translating it into LINQ costs time and loses fidelity, and translating bugs back is worse.
2. **Speed.** For read-heavy endpoints that return large results, Dapper's overhead is close to
   hand-written ADO.NET.
3. **Database compatibility.** The main database was MySQL-compatible, but not compatible enough
   for EF Core's provider in every case. Database-first scaffolding worked for one schema and failed
   for others, and mapping everything by hand ate the benefit.
4. **Testing didn't get easier.** They tried EF Core with the in-memory provider (and an in-memory
   SQL variant) to replace the database in tests. With native SQL in the mix, the results didn't
   match what they hoped for.

Their conclusion was nuanced: EF Core can make sense, and for small, simple tools it might be the
better choice. *Think first.*

I'd add two things from today's perspective. EF Core has improved a lot: `SqlQuery<T>` for unmapped
types, compiled queries, much better performance than the versions that decision was based on. And
Microsoft itself now [recommends against the in-memory provider for testing](https://learn.microsoft.com/ef/core/testing/choosing-a-testing-strategy),
so point 4 is a known limitation, not bad luck. Neither changes the core argument: **if your team
thinks in SQL, use a tool that speaks SQL.**

## Dapper in modern C#

Dapper is a set of extension methods on `DbConnection`. You give it SQL and parameters, it gives you
objects.

```csharp
public sealed record OrderSummary(long Id, string CustomerName, decimal Total, DateTime OrderedAt);

public sealed class GetRecentOrdersQuery(DbDataSource dataSource)
{
    private const string Sql = """
        SELECT o.Id, c.Name AS CustomerName, o.Total, o.OrderedAt
        FROM Orders o
        JOIN Customers c ON c.Id = o.CustomerId
        WHERE o.Region = @Region AND o.OrderedAt >= @Since
        ORDER BY o.OrderedAt DESC
        LIMIT @Take
        """;

    public async Task<IReadOnlyList<OrderSummary>> ExecuteAsync(string region, DateTime since, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        var rows = await connection.QueryAsync<OrderSummary>(new CommandDefinition(
            Sql,
            new { Region = region, Since = since, Take = 100 },
            cancellationToken: ct));

        return rows.AsList();
    }
}
```

A few things in there are deliberate:

- **One class per query.** The team's checklist said: every SQL statement lives in its own query
  (`SELECT`) or command (`INSERT`/`UPDATE`/`DELETE`) class. That makes SQL easy to find, review and
  test, and the class name documents intent.
- **`DbDataSource`** (since .NET 7) is the modern way to hand out connections. Register it once
  (for example `MySqlDataSource`, `NpgsqlDataSource`), and open a connection per operation. Pooling
  makes that cheap.
- **`CommandDefinition`** is the only way to pass a **`CancellationToken`** to Dapper. The
  convenient `QueryAsync(sql, param)` overload doesn't take one. If the caller disconnects, the query
  keeps running.
- **Parameters, always.** `@Region` is a real parameter. Never put values into the SQL with string
  interpolation.
- **`AsList()`** returns the underlying list without copying it, since Dapper buffers by default.

### The other everyday operations

```csharp
// Single row
var order = await connection.QueryFirstOrDefaultAsync<OrderSummary>(
    new CommandDefinition("SELECT ... WHERE o.Id = @Id", new { Id = orderId }, cancellationToken: ct));

// Commands
var affected = await connection.ExecuteAsync(
    new CommandDefinition("UPDATE Orders SET Status = @Status WHERE Id = @Id",
                          new { Id = orderId, Status = "Shipped" }, cancellationToken: ct));

// Several result sets in one round trip
using var multi = await connection.QueryMultipleAsync(new CommandDefinition("""
    SELECT Id, Name FROM Customers WHERE Id = @Id;
    SELECT Id, Total FROM Orders WHERE CustomerId = @Id;
    """, new { Id = customerId }, cancellationToken: ct));

var customer = await multi.ReadSingleAsync<Customer>();
var orders   = (await multi.ReadAsync<OrderRow>()).AsList();

// Large results without buffering everything in memory (Dapper 2.1+)
await foreach (var row in connection.QueryUnbufferedAsync<OrderRow>(
                   "SELECT Id, Total FROM Orders WHERE Region = @Region", new { Region = region }))
{
    // process one row at a time
}
```

### Multi-mapping

Joins that should produce an object graph use multi-mapping. `splitOn` tells Dapper where the next
object's columns start:

```csharp
const string sql = """
    SELECT o.Id, o.Total, c.Id, c.Name
    FROM Orders o JOIN Customers c ON c.Id = o.CustomerId
    WHERE o.Id = @Id
    """;

var result = await connection.QueryAsync<OrderRow, CustomerRow, Order>(
    new CommandDefinition(sql, new { Id = orderId }, cancellationToken: ct),
    (order, customer) => new Order(order.Id, order.Total, customer),
    splitOn: "Id");   // the second "Id" column starts CustomerRow
```

## Mistake 1: the materialization exception

This one shows up sooner or later in every Dapper codebase:

```text
A parameterless default constructor or one matching signature
(System.String Id, System.String LastName, System.String FirstName, System.String Email,
 System.String Level) is required for MyShop.Customers.CustomerSuggestion materialization
```

The record looked like this:

```csharp
public sealed record CustomerSuggestion(long Id, string LastName, string FirstName, string Email, CustomerLevel Level);
```

For positional records, Dapper looks for a constructor whose parameters match the result columns
**by name and by type**. The database returned `Id` and `Level` as strings, the record expected a
`long` and an enum, so no constructor matched. The message even tells you what the columns look
like: that signature in parentheses is **what the database returned**, not what your type has.

Two fixes, depending on what's wrong:

- **The schema changed** (or was never what you thought): adjust the record to the real column
  types, or `CAST` in SQL.
- **You want a richer domain type:** map into a row record that mirrors the table exactly, then
  convert. Or register a type handler for the custom type:

```csharp
public sealed class CustomerLevelHandler : SqlMapper.TypeHandler<CustomerLevel>
{
    public override CustomerLevel Parse(object value) => Enum.Parse<CustomerLevel>((string)value, ignoreCase: true);
    public override void SetValue(IDbDataParameter parameter, CustomerLevel value) => parameter.Value = value.ToString();
}

SqlMapper.AddTypeHandler(new CustomerLevelHandler());
```

The deeper lesson the team wrote down: this error shows up **at runtime, on the first call**. A
simple integration test that executes every query once against a real database would have caught it
before deployment.

## Mistake 2: IN lists that grow

Dapper has a convenient feature: pass a collection, and it expands `IN @Ids` into `IN (@Ids1, @Ids2,
...)` for you.

```csharp
var rows = await connection.QueryAsync<AccessRow>(new CommandDefinition(
    "SELECT ... WHERE r.Id IN @Ids", new { Ids = resourceIds }, cancellationToken: ct));
```

That's fine for ten IDs. It's not fine for a few thousand. In one system, a permission query with an
`IN` list of **1,225 values** ran into timeouts after 30 seconds. MySQL accepts very long lists in
theory, but parsing, memory and missing index use make them slow long before any hard limit (SQL
Server stops at 2,100 parameters per command).

The quick fix there was to split the list into chunks of 100 and run the chunks in parallel:

```csharp
var tasks = resourceIds
    .Chunk(100)
    .Select(chunk => repository.GetAccessAsync(request, chunk, ct));

var results = await Task.WhenAll(tasks);
var all = results.SelectMany(r => r).ToList();
```

That took the request from about 40 seconds to a little over 4. A real fix goes further: a join
against the table the IDs came from, a temporary table, or a table-valued parameter on SQL Server.
And mind the connection pool when you parallelize: 13 chunks means 13 connections at once. The
[SQL IN clauses](/blog/2026-sql-in-clause-parameters/) post goes deeper into the alternatives.

## Mistake 3: TransactionScope and async

```csharp
using var scope = new TransactionScope();                  // ❌
await connection.ExecuteAsync("INSERT ...");
scope.Complete();
```

This throws `InvalidOperationException: A TransactionScope must be disposed on the same thread that
it was created` as soon as the `await` resumes on another thread. One team hit it right after
upgrading their MySQL driver. `TransactionScope` uses thread-local state by default. With async code
you have to opt into flowing it:

```csharp
using var scope = new TransactionScope(TransactionScopeAsyncFlowOption.Enabled);   // ✅
await connection.ExecuteAsync("INSERT ...");
scope.Complete();
```

Better still, for a single connection, use an explicit transaction and pass it to every call:

```csharp
await using var connection = await dataSource.OpenConnectionAsync(ct);
await using var tx = await connection.BeginTransactionAsync(ct);

await connection.ExecuteAsync(new CommandDefinition(deleteSql, new { Region = region }, tx, cancellationToken: ct));
await connection.ExecuteAsync(new CommandDefinition(insertSql, rows, tx, cancellationToken: ct));

await tx.CommitAsync(ct);
```

`TransactionScope` can escalate to a distributed transaction when a second connection joins, which
most drivers and cloud databases don't support. An explicit `DbTransaction` doesn't have that
surprise. More on the async side of it in
[TransactionScope and async](/blog/2026-transactionscope-async/).

## Mistake 4: interpolated SQL

```csharp
var sql = $"SELECT * FROM Orders WHERE Region = '{region}'";   // ❌ SQL injection
await connection.QueryAsync<OrderRow>(sql);
```

Dapper doesn't parameterize interpolated strings. Whatever is in `region` ends up in the SQL. The
team's code-review checklist had this as an explicit item: **every SQL statement is injection-safe,
all values go through parameters**. The only things that may be interpolated are identifiers you've
validated against a whitelist (table or column names for dynamic sorting), quoted with the database's
quoting rules.

## Dapper, EF Core or raw ADO.NET?

| | Raw ADO.NET | Dapper | EF Core |
|---|---|---|---|
| You write SQL | ✅ always | ✅ always | ⚠️ optional (`FromSql`, `SqlQuery`) |
| Mapping | Manual | Automatic, by name | Automatic, by model |
| Change tracking, migrations | ❌ | ❌ | ✅ |
| Overhead | None | Very low | Low to moderate |
| Hand-tuned SQL from DB experts | ✅ | ✅ | ⚠️ translation or raw SQL |
| Strong compile-time model | ❌ | ❌ (✅ checks with Dapper.AOT) | ✅ |
| Best for | Hot paths, bulk work | Read-heavy, SQL-first teams | Domain-heavy CRUD, model-first teams |

They also mix well. EF Core for the transactional core with change tracking, Dapper for reporting
queries against the same database, is a combination I've seen work nicely.

For bulk inserts, neither Dapper nor EF Core is the right tool on its own. Use the driver's bulk API
(`SqlBulkCopy`, `MySqlBulkCopy`, PostgreSQL `COPY`) or a dedicated library.

## How to keep it safe

- **Execute every query in a test.** One integration test per query class, against a real database
  in a container ([Testcontainers](https://dotnet.testcontainers.org/)). That catches materialization
  errors, typos in column names and schema drift.
- **Use [Dapper.AOT](https://aot.dapperlib.dev/).** It's a source generator that replaces Dapper's
  runtime code generation (so it works with Native AOT), and its analyzers flag common mistakes at
  build time.
- **Ban interpolated SQL.** A Roslyn analyzer or at least a code-review rule. CA2100 covers
  `DbCommand.CommandText`, but not Dapper's extension methods, so you need your own check. That's the
  idea behind [self-defending codebases](/blog/2026-self-defending-codebases/).
- **Watch the database side.** OpenTelemetry instrumentation for your ADO.NET driver gives you a span
  per query, including duration. Slow queries and suspiciously many queries per request show up
  there first.

## Summary

- When **SQL is the source of truth** and your team thinks in SQL, Dapper avoids the LINQ round trip
  and stays close to raw ADO.NET speed.
- Use **one class per query**, `DbDataSource`, and **`CommandDefinition`** so cancellation works.
- **Materialization errors** mean your type and the result columns don't match by name and type. The
  message shows what the database returned.
- **Chunk big `IN` lists** (or better, join), use **`TransactionScopeAsyncFlowOption.Enabled`** or
  an explicit transaction, and **never interpolate values** into SQL.
- **Execute every query in an integration test**, and consider Dapper.AOT for build-time checks.
