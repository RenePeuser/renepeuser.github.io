---
title: API integration tests in one line — getting started with AspNetCore.Simple.MsTest.Sdk
date: 2026-11-24
authors: rene
tags: [dotnet, testing, aspnetcore, open-source, mstest]
excerpt: Fifteen lines of HttpClient plumbing and cherry-picked asserts per endpoint, or one line and a JSON file? A hands-on start with AspNetCore.Simple.MsTest.Sdk — setup, file-based snapshots of the whole HTTP response, one test per JSON file, and how to handle IDs and timestamps.
---

Every ASP.NET Core team I've worked with writes the same API test over and over. Build an `HttpClient`,
serialize a request, send it, check the status code, read the body, deserialize it, and then assert two
or three fields someone thought were important. Fifteen lines per test, and the test still doesn't
notice when a header changes or a new field leaks into the response.

[AspNetCore.Simple.MsTest.Sdk](https://github.com/RenePeuser/AspNetCore.Simple.MsTest.Sdk) is my answer
to that. I started it in 2021 (the [backstory is here](/blog/2021-aspnetcore-simple-mstest-sdk/)), it
has passed 700,000 downloads on [NuGet](https://www.nuget.org/packages/AspNetCore.Simple.MsTest.Sdk/),
and today it targets .NET 10. This post is the practical start: from an empty test project to a suite
where **adding a JSON file adds a test**.

## The "before": what an API test usually looks like

```csharp
[TestMethod]
public async Task Should_Create_User()
{
    var request = new UserRequest(1, "Son", "Goku", 99, []);
    var content = new StringContent(JsonSerializer.Serialize(request), Encoding.UTF8, "application/json");

    var response = await _client.PostAsync("api/v1/users", content);

    Assert.AreEqual(HttpStatusCode.OK, response.StatusCode);
    Assert.AreEqual("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());

    var body = await response.Content.ReadFromJsonAsync<UserResponse>();
    Assert.AreEqual("Son", body!.Name);
    Assert.AreEqual("Goku", body.FirstName);
    Assert.AreEqual(99, body.Age);
}
```

This test costs time in three places:

- **Writing it.** Most of the lines are plumbing, not intent.
- **Maintaining it.** When the contract changes, every assert has to be found and rewritten.
- **Debugging it.** When it fails, you get `Assert.AreEqual failed. Expected:<Son>. Actual:<>.` and
  start rebuilding the request by hand.

And it has a blind spot that hurts more than all three: it only checks the fields someone remembered.
If the endpoint starts returning an internal `passwordHash` field, this test stays green.

## The "after"

```csharp
[TestMethod]
public Task Should_Create_User()
{
    return Client.AssertPostAsync<UserResponse>("api/v1/users",
                                                "CreateUser.json",
                                                "CreateUser.json");
}
```

One call. The first `CreateUser.json` is the request body, the second is the expected response, both
embedded files next to the test. The call sends the request, validates the status code, the
`Content-Type`, the headers and the whole body, checks the response type against the endpoint's
declared contract, and on failure prints a structured diff plus a ready-to-run `curl`.

The same test also exists as a fluent chain that reads like the endpoint metadata it verifies:

```csharp
[TestMethod]
public Task Should_Create_User()
{
    return Client.AssertPost("api/v1/users")
                 .AcceptsFromEmbeddedJson("CreateUser.json")
                 .Produces<UserResponse>(HttpStatusCode.OK)
                 .ExpectedResponseFromEmbeddedJson("CreateUser.json")
                 .ExecuteAsync();
}
```

Both styles run the same pipeline. I'll use the classic style in this post and cover the fluent API,
and the analyzers that protect it, [in part three](/blog/2026-mstest-sdk-fluent-api-and-analyzers/).

## Setup: one base class, nothing to wire up

```sh
dotnet add package AspNetCore.Simple.MsTest.Sdk
```

The SDK ships `ApiTestBase<TStartup>`, a thin wrapper around `WebApplicationFactory`. One assembly-wide
base class in your test project is enough:

```csharp
[TestClass]
public abstract class ApiTestBase
{
    private static ApiTestBase<Program> _apiTestBase = null!;

    [AssemblyInitialize]
    public static void AssemblyInitialize(TestContext _)
    {
        // Program for minimal APIs / top-level statements, Startup for a classic Startup.cs.
        _apiTestBase = new ApiTestBase<Program>("Development",
                                                (services, configuration) =>
                                                {
                                                    // Only your own overrides / test doubles go here.
                                                });

        Client = _apiTestBase.CreateClient();
    }

    protected static HttpClient Client { get; private set; } = null!;

    [AssemblyCleanup]
    public static void AssemblyCleanup()
    {
        _apiTestBase.Dispose();
        Client.Dispose();
    }
}
```

`ApiTestBase<TStartup>` calls `services.AddAssertableHttpClient(configuration)` for you. That registers
the endpoint registry used for contract validation, the diff engine and the failure reporters inside
the host under test. The static `Assert…Async` extensions resolve from that container once the host has
started.

Already have your own `WebApplicationFactory<T>` or fixture? Then it's exactly one line in your host:

```csharp
builder.ConfigureServices((context, services) =>
{
    services.AddAssertableHttpClient(context.Configuration, settings =>
    {
        settings.WriteResponse = false;
    });
});
```

Forget it, and the first assert tells you what's missing instead of failing with a
`NullReferenceException`:

```text
⚠️  MISSING REGISTRATION

The AssertableHttpClient requires endpoint registration to validate HTTP calls.
Please ensure the sdk is registered in the host under test and the host is started
(ApiTestBase<T> or your own WebApplicationFactory) before the first assert:

  services.AddAssertableHttpClient(configuration, settings => { ... });
```

The JSON files are embedded resources. The sample projects in the repository use one line in the test
`.csproj` for all of them:

```xml
<ItemGroup>
    <EmbeddedResource Include="**\*.json" Exclude="bin\**\*;obj\**\*;appsettings*.json" />
</ItemGroup>
```

:::note[Why the whole base-class question matters]
The SDK's base class only starts the app and hands out a client. That's deliberate, and it's the same
rule I describe in [the integration test base class that does one thing](/blog/2026-api-integration-test-base-class/):
no business helpers, no shared state, no "create a default customer" methods in the base.
:::

## The snapshot is the whole HTTP response

The expected file isn't just the body. It's the full response envelope:

```json
{
  "Content": {
    "Headers": [
      {
        "Key": "Content-Type",
        "Value": [ "application/json; charset=utf-8" ]
      }
    ],
    "Value": {
      "Id": 1,
      "Name": "Son",
      "FirstName": "Goku",
      "Age": 99,
      "Emails": []
    }
  },
  "StatusCode": "OK",
  "Headers": [],
  "TrailingHeaders": [],
  "IsSuccessStatusCode": true
}
```

That's the point where snapshot tests beat cherry-picked asserts:

| Change in the API | Hand-written asserts | Full-response snapshot |
|---|---|---|
| A value changes | Caught, if that field is asserted | Caught, with its exact path |
| A field disappears | Caught, if asserted | Caught as `MissingInFirst` / `MissingInSecond` |
| A new field appears (e.g. leaked internals) | **Not caught** | Caught |
| `Content-Type` or another header changes | Usually not caught | Caught |
| Status `200` becomes `201` | Caught, if asserted | Caught |

Volatile headers such as `traceparent` are ignored by default through `TestSdkSettings.VolatileHeaderNames`,
so the snapshot doesn't break on every run.

You don't type these files by hand, either. Pass `writeResponse: true` once (or set the environment
variable `TestSdkSettings__WriteResponse=true` for a whole run), run the test in a Debug build, review the
recorded file in the diff and commit it. Recording is deliberately Debug-only; in Release the flag is
ignored, so a forgotten switch can't keep a CI build green.

## One JSON file, one test case: `DynamicRequestLocator`

This is the feature that changes the economics of API testing. Put the request files into a `Requests`
folder and the expected files with the same names into `Responses`:

```text
Api
└─ Users
   └─ V1
      └─ Create
         └─ Status_200_Ok
            ├─ Requests
            │  ├─ ValidUser.json
            │  ├─ AdminUser.json
            │  └─ GuestUser.json
            ├─ Responses
            │  ├─ ValidUser.json
            │  ├─ AdminUser.json
            │  └─ GuestUser.json
            └─ CreateUser_Status_200_OK_Test.cs
```

Then write the test once:

```csharp
namespace Api.Users.V1.Create.Status_200_Ok;

[TestClass]
public class CreateUser_Status_200_OK_Test : ApiTestBase
{
    [TestMethod]
    [DynamicRequestLocator]
    public Task Should_Create_User(string requestFileName)
    {
        return Client.AssertPostAsync<UserResponse>("api/v1/users",
                                                    requestFileName,
                                                    requestFileName);
    }
}
```

`DynamicRequestLocatorAttribute` is an MSTest `ITestDataSource`. It takes the test class's namespace,
appends `.Requests`, finds every embedded `.json` file in that folder and yields one test case per file.
The file name becomes the test name in the runner.

The practical effect:

- **A bug report becomes a regression test** by dropping one request file and recording its response.
- **Deleting a scenario** is deleting two files. There's no `[DataRow]` list that drifts out of sync.
- **Coverage grows with files, not code.** Thirty edge cases are thirty files and still one test method.

File references stay short because resolution is namespace-aware. `"Requests.SonGoku.json"` from a test
in `Api.Persons` picks `Api.Persons.Requests.SonGoku.json`, even if `Api.Errors.Requests.SonGoku.json`
exists too. Matching is segment-based, so `Requests.SonGoku.json` never matches `ErrorRequests.SonGoku.json`.

The same idea exists for enums: `[EnumTestCase<Status>()]` yields one test case per enum value, so a new
enum member gets a test without anyone remembering to add a `DataRow`.

## Dynamic values: IDs, timestamps, placeholders

A strict snapshot needs a strategy for values that change on every run. The SDK has three, from coarse
to precise.

**Ignore by path, globally.** Database-generated IDs or timestamps that every response carries:

```csharp
services.AddAssertableHttpClient(configuration, settings =>
    settings.DifferenceFilter = difference => difference.MemberPath != "content.value.id");
```

**Ignore by path, per test.** Same predicate, scoped to one assert:

```csharp
await Client.AssertPostAsync<AddUserResponse>("api/v1/users",
                                              "NewUser.json",
                                              "NewUser.json",
                                              differenceFilter: d => !d.MemberPath.Contains("timestamp"));
```

The `MemberPath` is the camelCase JSON path exactly as the failure table prints it, for example
`content.value.emails[1].type`. Copy it from a failing run and you have your filter.

**Fill it in.** When a value is known at runtime, put a placeholder into the snapshot and pass the value:

```csharp
var user = await CreateUserAsync();

await Client.AssertGetAsync<GetUserByIdResponse>($"api/v1/users/{user.Id}",
                                                 "GetUser.json",
                                                 [("$Id$", user.Id)]);
```

```json
{ "content": { "value": { "id": "$Id$", "name": "Son", "age": 99 } } }
```

Prefer the placeholder over ignoring. An ignored field is a field nobody checks; a placeholder still
proves the API returned the right ID.

Arrays without a meaningful order (tags, anything a producer emits in a different order per run) can be
marked with `settings.OrderIndependentArrayFilter`. Their elements are then matched instead of compared
by index, so a pure reordering isn't a difference, while a missing or changed element still is.

## C# objects instead of files

Files are great for big payloads and for `DynamicRequestLocator`. For small, stable data, objects give
you refactoring and IntelliSense. Every assert accepts both, and you can mix them:

```csharp
[TestMethod]
public Task Should_Create_Person()
{
    var personToCreate = new Person(Id: 0, Name: "Son", FirstName: "Goku", Age: 99,
                                    Emails: ImmutableList<Email>.Empty);
    var expectedPerson = personToCreate with { Id = 1 };

    return Client.AssertPostAsync("api/v1/persons", personToCreate, expectedPerson);
}
```

| Scenario | Use |
|---|---|
| Simple, stable test data | C# objects |
| Large, nested payloads | JSON files |
| Many input variations | JSON files + `DynamicRequestLocator` |
| Generated or computed data | C# objects |

## The other HTTP verbs, including QUERY

Every verb follows the same shape, with an `AsErrorAsync` variant for 4xx/5xx responses and a
non-generic variant for `204 No Content`:

```csharp
var created = await Client.AssertPostAsync<User>("api/v1/users", "CreateUser.json", "CreatedUser.json");

await Client.AssertGetAsync<User>($"api/v1/users/{created.Id}", "UserDetails.json");
await Client.AssertQueryAsync<SearchResults>("api/v1/users/search", "SearchRequest.json", "SearchResults.json");
await Client.AssertPutAsync<User>($"api/v1/users/{created.Id}", "UpdateUser.json", "UpdatedUser.json");
await Client.AssertDeleteAsync($"api/v1/users/{created.Id}");   // non-generic: expects 204

await Client.AssertPostAsErrorAsync<ProblemDetails>("api/v1/errors/not-implemented", "ErrorResponse.json");
```

`AssertQueryAsync` covers the HTTP `QUERY` method from RFC 10008: a safe, cacheable read that can carry
a request body. It's the right verb for complex searches that you'd otherwise squeeze into a `POST`.

The generic/non-generic split isn't cosmetic. `AssertPostAsync("api/v1/items", "NewItem.json")` without
`<T>` says "this endpoint returns no body", and the SDK fails the test if the endpoint is declared to
return one. More on that contract check in [part two](/blog/2026-mstest-sdk-failures-that-explain-themselves/).

## Pitfalls

- **Recording and never reviewing.** A recorded snapshot is only as good as the review of its diff.
  Treat a changed `.json` file in a pull request like changed production code.
- **Ignoring too much.** A global filter on `Contains("id")` also hides `orderId`, `customerId` and
  `paidAt`-adjacent mistakes. Filter exact paths, and prefer placeholders.
- **Forgetting the embedded resource.** A new JSON file that isn't embedded is a "file not found" at
  runtime. The wildcard `EmbeddedResource` line above avoids it.
- **One giant snapshot per process.** Snapshots work best per endpoint and per scenario. For a
  multi-step flow, validate the first and last step fully and let intermediate steps only prove they
  succeed: `Client.AssertPostAsync<EmailSentResponse>(url)` without an expected file still validates
  the endpoint and the response type.

## Summary

- One assert call sends the request and validates **status, headers and the whole body** against an
  embedded snapshot, plus the endpoint's declared contract.
- `ApiTestBase<TStartup>` or a single `AddAssertableHttpClient` call is the entire setup.
- `DynamicRequestLocator` turns **one JSON file into one test case**; a bug report becomes a regression
  test without new code.
- Handle dynamic values with exact-path filters, placeholders and order-independent arrays, in that
  order of preference: placeholders first.
- Record snapshots in Debug with `writeResponse: true`, review the diff, commit.

Next: [failures that explain themselves](/blog/2026-mstest-sdk-failures-that-explain-themselves/), the
part of the SDK that saves the most time once a suite is big.
