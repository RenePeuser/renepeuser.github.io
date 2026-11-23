---
title: Test patterns for GET, POST and DELETE
date: 2026-11-23
authors: rene
tags: [testing, aspnetcore, api-design]
excerpt: Most API test suites test the happy path of GET and call it a day. A repeatable checklist per HTTP verb, from the 401 to the "deleted means gone" check, plus the setup and cleanup rules that keep those tests independent of each other and of the system state.
---

:::note[Series]
Part of the series [*Testing in practice*](/series/testing-in-practice/).
:::

When I review an API test suite, I don't read the tests first. I list the endpoints and ask, for
each one: *where's the 401 test? Where's the 404 for a missing parent? What proves that a DELETE
actually deleted something?* In most suites, the answer for the majority of endpoints is "there
isn't one". There's a happy-path GET against data somebody created by hand two years ago.

This post is the checklist I use instead: a fixed set of test cases per verb, written in the same
shape every time, so a missing case is as obvious as a missing line in a table.

## The problem: tests against "whatever is in the database"

The typical first test looks like this:

```csharp
[TestMethod]
public async Task GetOrder()
{
    var order = await Client.GetFromJsonAsync<OrderResponse>("api/v1/orders/42");

    Assert.IsNotNull(order);
    Assert.AreEqual("Open", order.Status);
}
```

It passes as long as order 42 exists and stays open. Someone closes it manually, a migration changes
it, another test deletes it, or the test runs against a fresh environment, and it fails without any
change to the code. Worse, it only tests one of at least five things the endpoint has to get right.

## The checklist

For the examples I'll use order lines, a child resource:

```text
GET    api/v1/orders/{orderId}/lines
GET    api/v1/orders/{orderId}/lines/{lineId}
POST   api/v1/orders/{orderId}/lines
DELETE api/v1/orders/{orderId}/lines/{lineId}
DELETE api/v1/orders/{orderId}/lines
```

And this is the minimum per verb:

| Case | GET list | GET {id} | POST | DELETE {id} | DELETE all |
|---|---|---|---|---|---|
| No / invalid token → `401` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Valid token, missing permission → `403` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Parent doesn't exist → `404` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Item doesn't exist → `404` | | ✅ | | ✅ | |
| Invalid payload → `400` with details | | | ✅ | | |
| Duplicate / conflicting state → `409` | | | ✅ | | |
| Empty state returns an empty result | ✅ | | | | |
| Happy path, verified through a second call | ✅ | ✅ | ✅ | ✅ | ✅ |

That looks like a lot. In practice each row is three to eight lines of test code, and the table is
the same for every resource, which means you stop thinking about *what* to test and only think about
the domain-specific extras.

:::tip[Order matters]
Write the security and validation rows first, the happy path last. A happy-path test is the one
you'll write anyway. The `401` is the one that's forgotten, and it's the one that matters most
when it's missing.
:::

## A tiny helper so the tests stay short

The examples use two helpers. One sends requests with or without data, the other compares the full
JSON response with an expected file and the status code with the expected one:

```csharp
public static class HttpResponseAssertions
{
    public static async Task AssertJsonAsync(
        this HttpResponseMessage response,
        HttpStatusCode expectedStatus,
        string expectedFile,
        params string[] ignoredProperties)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.AreEqual(expectedStatus, response.StatusCode, body);

        var actual   = JsonNode.Parse(body)!;
        var expected = JsonNode.Parse(TestFiles.Read(expectedFile))!;

        foreach (var property in ignoredProperties)
        {
            actual.RemovePath(property);
            expected.RemovePath(property);
        }

        Assert.IsTrue(JsonNode.DeepEquals(expected, actual),
            $"Response differs from '{expectedFile}'.{Environment.NewLine}Actual:{Environment.NewLine}{actual}");
    }
}
```

`TestFiles.Read` loads an embedded JSON file, `TestFiles.Json` wraps it in a `StringContent` with
`application/json`, and `RemovePath` is a ten-line extension that removes a property by a simple path
such as `lines[*].id`.

That's deliberately minimal. A real setup wants a property-level diff, `curl` output and full HTTP
response snapshots. I wrote about that in the
[retrospective on my test SDK](/blog/2021-aspnetcore-simple-mstest-sdk/), and tools like Verify.Http
do it too. The patterns below work with any of them.

## Setup and cleanup: cleanup first, via the API, by tag

Before the patterns, the rules that make them reliable:

```csharp
[TestClass]
public sealed class OrderLines_Tests : ApiTestBase
{
    // Unique per machine / pipeline agent, but stable between runs on the same machine.
    private static readonly string TestTag = $"it-orderlines-{TestRun.RunnerName}";

    private Guid _orderId;

    [TestInitialize]
    public async Task SetupAsync()
    {
        await CleanupAsync();                                   // 1. clean up leftovers first

        var response = await Client.PostAsJsonAsync("api/v1/orders",
            new { CustomerNumber = "C-1000", Reference = TestTag });   // 2. create the parent via the API

        _orderId = (await response.Content.ReadFromJsonAsync<OrderResponse>())!.Id;
    }

    [TestCleanup]
    public Task CleanupAsync() =>
        Client.DeleteAsync($"api/v1/orders?reference={TestTag}");      // 3. delete everything with our tag
}
```

- **Cleanup runs first, in the setup.** If the last run was killed in the debugger, `TestCleanup`
  never ran. Starting with a cleanup makes the test self-healing.
- **Clean up by tag, not by tracked IDs.** A list of "IDs I created" lives in memory and dies with
  the process. A tag (a reference, a name prefix) survives, so the next run can find the leftovers.
- **Unique per runner.** When the pipeline and two developers run the same tests against the same
  shared environment, a fixed tag means they delete each other's data mid-test. Machine name plus
  something stable is enough.
- **Only through the API.** No direct SQL inserts, no repository calls in setup. A test that knows
  your tables breaks when you refactor the schema, even if the API stays the same, and a consuming
  team can't write such tests at all.

That last rule has a consequence for API design: **if you only need a GET, build the POST and
DELETE anyway.** A read-only API can only be tested against existing state, and that's exactly the
"order 42" problem from above.

## GET (list)

```csharp
[TestMethod]
public async Task Should_Return_401_When_No_Token_Is_Sent()
{
    var response = await AnonymousClient.GetAsync($"api/v1/orders/{_orderId}/lines");

    Assert.AreEqual(HttpStatusCode.Unauthorized, response.StatusCode);
}

[TestMethod]
public async Task Should_Return_404_When_Order_Does_Not_Exist()
{
    var response = await Client.GetAsync("api/v1/orders/00000000-0000-0000-0000-000000000001/lines");

    await response.AssertJsonAsync(HttpStatusCode.NotFound, "OrderLines/Results/OrderNotFound.json", "traceId");
}

[TestMethod]
public async Task Should_Return_Empty_List_When_Order_Has_No_Lines()
{
    var response = await Client.GetAsync($"api/v1/orders/{_orderId}/lines");

    await response.AssertJsonAsync(HttpStatusCode.OK, "OrderLines/Results/NoLines.json");
}

[TestMethod]
public async Task Should_Return_Lines_That_Were_Added()
{
    await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Mug.json"));
    await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Plate.json"));

    var response = await Client.GetAsync($"api/v1/orders/{_orderId}/lines");

    await response.AssertJsonAsync(HttpStatusCode.OK, "OrderLines/Results/MugAndPlate.json", "lines[*].id");
}
```

The **empty list test** is underrated. It catches the classic "returns `404` instead of `[]`" bug,
the "returns `null`" bug and a missing tenant filter that leaks other customers' data into an order
that should have no lines at all.

## GET {id}

Two different 404s, and they must be distinguishable:

```csharp
[TestMethod]
public async Task Should_Return_404_When_Order_Does_Not_Exist()
{
    var response = await Client.GetAsync($"api/v1/orders/{Guid.NewGuid()}/lines/{Guid.NewGuid()}");

    await response.AssertJsonAsync(HttpStatusCode.NotFound, "OrderLines/Results/OrderNotFound.json", "traceId", "detail");
}

[TestMethod]
public async Task Should_Return_404_When_Line_Does_Not_Exist()
{
    var response = await Client.GetAsync($"api/v1/orders/{_orderId}/lines/{Guid.NewGuid()}");

    await response.AssertJsonAsync(HttpStatusCode.NotFound, "OrderLines/Results/LineNotFound.json", "traceId", "detail");
}
```

Comparing the full problem response matters here. If both cases return a bare `404`, a consumer can't
tell "your order ID is wrong" from "that line was already removed", and neither can your test.

The happy path for GET {id} uses the ID that POST returned, never a hard-coded one:

```csharp
[TestMethod]
public async Task Should_Return_The_Line_That_Was_Added()
{
    var added = await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Mug.json"));
    var line  = await added.Content.ReadFromJsonAsync<OrderLineResponse>();

    var response = await Client.GetAsync($"api/v1/orders/{_orderId}/lines/{line!.Id}");

    await response.AssertJsonAsync(HttpStatusCode.OK, "OrderLines/Results/Mug.json", "id");
}
```

## POST

```csharp
[TestMethod]
public async Task Should_Return_403_When_Token_Has_No_Write_Scope()
{
    using var request = new HttpRequestMessage(HttpMethod.Post, $"api/v1/orders/{_orderId}/lines")
    {
        Content = TestFiles.Json("OrderLines/Payloads/Mug.json")
    };
    request.Headers.Authorization = new("Test", TestUsers.ReadOnly);

    var response = await Client.SendAsync(request);

    Assert.AreEqual(HttpStatusCode.Forbidden, response.StatusCode);
}

[TestMethod]
public async Task Should_Return_400_When_Quantity_Is_Zero()
{
    var response = await Client.PostAsync($"api/v1/orders/{_orderId}/lines",
                                          TestFiles.Json("OrderLines/Payloads/QuantityZero.json"));

    await response.AssertJsonAsync(HttpStatusCode.BadRequest, "OrderLines/Results/QuantityZero.json", "traceId");
}

[TestMethod]
public async Task Should_Return_409_When_Same_Product_Is_Added_Twice()
{
    var payload = "OrderLines/Payloads/Mug.json";
    await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json(payload));

    var response = await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json(payload));

    await response.AssertJsonAsync(HttpStatusCode.Conflict, "OrderLines/Results/ProductAlreadyOnOrder.json", "traceId");
}
```

Note how the `403` test sets the header **on the request**, not on the shared client. That's the
habit that avoids a whole category of flaky tests, see the
[base class post](/blog/2026-api-integration-test-base-class/).

For the happy path, a POST is only proven when a **second call** sees the result. The POST response
alone tells you what the handler returned, not what it stored:

```csharp
[TestMethod]
public async Task Should_Store_The_Line_That_Was_Posted()
{
    var post = await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Mug.json"));
    await post.AssertJsonAsync(HttpStatusCode.Created, "OrderLines/Results/Mug.json", "id");

    var get = await Client.GetAsync(post.Headers.Location);
    await get.AssertJsonAsync(HttpStatusCode.OK, "OrderLines/Results/Mug.json", "id");
}
```

Reusing the same expected file for both calls is a nice side effect: if POST and GET ever return
different shapes for the same resource, the test tells you.

## DELETE {id}: add, get, delete, get again

```csharp
[TestMethod]
public async Task Should_Not_Find_Line_After_It_Was_Deleted()
{
    // 1. add
    var post = await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Mug.json"));
    var line = await post.Content.ReadFromJsonAsync<OrderLineResponse>();
    var url  = $"api/v1/orders/{_orderId}/lines/{line!.Id}";

    // 2. it exists
    Assert.AreEqual(HttpStatusCode.OK, (await Client.GetAsync(url)).StatusCode);

    // 3. delete
    Assert.AreEqual(HttpStatusCode.NoContent, (await Client.DeleteAsync(url)).StatusCode);

    // 4. it's gone
    await (await Client.GetAsync(url)).AssertJsonAsync(HttpStatusCode.NotFound, "OrderLines/Results/LineNotFound.json", "traceId", "detail");
}
```

Step 2 is not optional. Without it, a broken POST makes the DELETE test pass: nothing was created,
nothing was found afterwards, green.

Also decide what a **second DELETE** returns (`404` or `204`) and write that down as a test. Both
are defensible. Not knowing which one your API does is not.

## DELETE all

Same idea, with more than one item so you can tell "deleted all" from "deleted the first":

```csharp
[TestMethod]
public async Task Should_Return_Empty_List_After_All_Lines_Were_Deleted()
{
    await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Mug.json"));
    await Client.PostAsync($"api/v1/orders/{_orderId}/lines", TestFiles.Json("OrderLines/Payloads/Plate.json"));

    var delete = await Client.DeleteAsync($"api/v1/orders/{_orderId}/lines");
    Assert.AreEqual(HttpStatusCode.NoContent, delete.StatusCode);

    var response = await Client.GetAsync($"api/v1/orders/{_orderId}/lines");
    await response.AssertJsonAsync(HttpStatusCode.OK, "OrderLines/Results/NoLines.json");
}
```

## Pitfalls

**Hard-coded IDs of existing data.** Any test that reads `orders/42` depends on state you don't
control. Create what you read, every time.

**Over-ignoring.** Ignoring `id` and `createdAt` is fine. Ignoring half the response because it's
"unstable" means you've stopped testing it. If a value is unstable, ask why. Unsorted lists, for
example, are usually a missing `ORDER BY`, not a test problem.

**One giant scenario test.** "Create, update, read, delete, read again" in one method is tempting.
When it fails at step 4 you have no idea whether steps 5 to 9 work. Keep one behaviour per test;
the steps inside a test are only there to set up and verify that behaviour.

**Tracking IDs for cleanup.** `List<Guid> _createdIds` plus a `TestCleanup` loop leaks data on every
interrupted run. Clean up by tag.

## Make it visible

Because every resource follows the same table, completeness becomes checkable. Two cheap ways:

- **Name tests consistently** (`Should_Return_401_When_...`, `Should_Return_404_When_...`). A simple
  search over the test names per test class shows which rows are missing.
- **Check the contract.** Every status code declared in the OpenAPI document
  (`Produces(404)`, `ProducesProblem(409)`) deserves at least one test that triggers it. A test that
  reads the OpenAPI document and the test names and lists the gaps is about forty lines of code.

## Summary

- Use a **fixed checklist per verb**: `401`, `403`, parent `404`, item `404`, `400`, `409`, empty
  state, happy path.
- Write the **security and validation tests first**; the happy path is the one you won't forget.
- Prove writes with a **second call**: POST then GET, DELETE then GET → `404`, and check that the
  item existed before you deleted it.
- **Cleanup first, via the API, by a per-runner tag.** Never set up data with direct database access.
- If an API only needs a GET, **build POST and DELETE anyway** so it can be tested without relying on
  existing state.
