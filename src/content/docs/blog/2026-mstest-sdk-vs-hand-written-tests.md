---
title: AspNetCore.Simple.MsTest.Sdk vs. hand-written WebApplicationFactory tests — an honest comparison
date: 2026-11-24
authors: rene
tags: [dotnet, testing, aspnetcore, open-source, architecture]
excerpt: I wrote the library, so take the praise with salt and read the trade-offs carefully. The same endpoint tested four ways, a side-by-side table, what you give up with a snapshot SDK, where it doesn't fit, and how to migrate an existing suite one test at a time.
---

I wrote [AspNetCore.Simple.MsTest.Sdk](https://github.com/RenePeuser/AspNetCore.Simple.MsTest.Sdk), so
I'm not a neutral judge. What I can do is put it next to the alternatives on the same endpoint, be
specific about what each approach costs, and be honest about where the SDK is the wrong tool. The
previous parts covered [getting started](/blog/2026-mstest-sdk-api-tests-in-one-line/),
[failure output and contract checks](/blog/2026-mstest-sdk-failures-that-explain-themselves/) and
[the fluent API with its analyzers](/blog/2026-mstest-sdk-fluent-api-and-analyzers/). This part is the
"should we use it" conversation.

## One endpoint, four tests

The endpoint: `POST api/v1/persons` creates a person and returns `201 Created` with the stored entity.

### 1. Plain `WebApplicationFactory` and MSTest asserts

```csharp
[TestMethod]
public async Task Should_Create_Person()
{
    var person = new Person(1, "Son", "Goku", 42, ImmutableList<Email>.Empty);

    var response = await _client.PostAsJsonAsync("api/v1/persons", person);

    Assert.AreEqual(HttpStatusCode.Created, response.StatusCode);
    var created = await response.Content.ReadFromJsonAsync<Person>();
    Assert.IsNotNull(created);
    Assert.AreEqual("Son", created.Name);
    Assert.AreEqual("Goku", created.FirstName);
    Assert.AreEqual(42, created.Age);
}
```

Zero dependencies beyond `Microsoft.AspNetCore.Mvc.Testing`, and every developer can read it. It also
checks four fields out of an unknown number, ignores headers, and on failure tells you
`Expected:<Son>. Actual:<>.` and nothing else.

### 2. `WebApplicationFactory` and an assertion library

```csharp
created.Should().BeEquivalentTo(person);
response.Content.Headers.ContentType!.MediaType.Should().Be("application/json");
```

`BeEquivalentTo` compares the whole object graph, which closes the "unasserted field" gap for the
*body*. The failure message lists the differing members. Headers and status still need separate
asserts, the request isn't part of the failure output, and the expected value lives in C#. That's great
for small objects and painful for a 200-line response.

### 3. `WebApplicationFactory` and a general snapshot library

Snapshot libraries such as Verify serialize the actual value into a file, and from then on compare
against the approved version. They're excellent and much more general than my SDK: any object, any
test framework, with scrubbing of GUIDs and dates out of the box and diff tooling integration. For HTTP
you still write the plumbing (create the request, send it, decide what goes into the snapshot) and you
don't get anything that knows about your endpoints.

### 4. AspNetCore.Simple.MsTest.Sdk

```csharp
[TestMethod]
public Task Should_Create_Person()
{
    return Client.AssertPost("api/v1/persons")
                 .Accepts(person)
                 .Produces<Person>(HttpStatusCode.Created)
                 .ExpectedResponseFromEmbeddedJson("CreatePerson.json")
                 .ExecuteAsync();
}
```

Status, headers and body against a snapshot of the whole HTTP response; the declared response type
checked against the endpoint's `.Produces<Person>(201)` metadata; on failure a categorized report with
JSON paths and a `curl`. In exchange you take a dependency that is opinionated about MSTest, JSON and
file layout.

## Side by side

| | Plain asserts | Assertion library | General snapshot lib | MsTest.Sdk |
|---|---|---|---|---|
| Lines per test | ~10–15 | ~8–12 | ~6–10 | 1–5 |
| Unasserted body fields caught | No | Yes | Yes | Yes |
| Headers and status in the same check | No | No | If you include them | Yes, by default |
| Expected data lives in | C# | C# | Files (approved snapshots) | Files or C# |
| Failure shows the exact path | No | Yes | Yes (diff tool) | Yes, `MemberPath` table |
| Failure shows the HTTP request / `curl` | No | No | No | Yes |
| Test checked against endpoint metadata | No | No | No | Yes |
| One test case per data file | Manual `DataRow` | Manual | Manual | `DynamicRequestLocator` |
| Test framework | Any | Any | Any | **MSTest** |
| Payloads | Anything | Anything | Anything | **JSON and text** |
| Extra dependency | None | One | One | One |

The table makes the trade clear. The SDK wins on the things that are specific to HTTP APIs: whole
responses, request context, endpoint contracts and file-driven scaling. The general tools win on
breadth.

## What you give up

Being opinionated is what makes the one-liners possible. It's also what you pay for.

**MSTest only.** `DynamicRequestLocator` and `EnumTestCase` are MSTest `ITestDataSource`
implementations, `Assert.That` extends MSTest's `Assert`, and the name says it. If your organization
standardized on xUnit or NUnit, this is a blocker, not a detail.

**JSON-centric.** JSON and plain text are fully supported. XML, `multipart/form-data`, form-urlencoded,
file uploads, binary responses, streaming and WebSockets aren't (the README is explicit about it). An
API that's mostly file uploads gets little out of the SDK.

**Snapshots need review discipline.** Recording is fast, so it's tempting to record and commit without
reading. A snapshot that captured a bug turns the bug into the expected behaviour. Treat changed `.json`
files in a pull request as carefully as changed production code.

**Strictness has a cost.** Comparing everything means volatile values must be handled: exact-path
filters, placeholders, order-independent arrays. That's a one-time investment per kind of value, but it
is an investment. A team that ignores half the response to get green builds has lost the point.

**It's another layer.** When something inside the SDK misbehaves, you debug someone else's pipeline.
The library is open source, has its own test suites for both APIs and the analyzers, and is used in
production, but it's still a dependency with a major-version history: 10.0 moved all global settings
into one settings class, 10.1 reduced registration to one public call. Upgrades are documented in the release notes,
and they're still work.

## Where it doesn't fit

The README lists these itself, and I agree with every one:

- **Pure unit tests.** No HTTP, no host. Use plain asserts; `Assert.That` works there too if you like
  the `because`/`fix` style.
- **Performance and load tests.** A snapshot comparison per request is the wrong measurement tool.
- **Tests of HTTP clients against third-party APIs**, where you mock the server. The SDK assumes it
  hosts the API under test.

## Where it shines

- **Contract and regression suites** for ASP.NET Core APIs, controllers and minimal APIs alike.
- **Many input variations per endpoint.** Validation rules, permission matrices, edge cases: one test
  method, many JSON files.
- **Teams where tests fail in CI and get fixed by someone else**, human or AI agent. The failure output
  carries everything needed to reproduce.
- **APIs where headers and status codes are part of the contract**, which is most public APIs.

## Migrating an existing suite

You don't need a big bang. The SDK plugs into the factory you already have with one registration:

```csharp
_factory = new WebApplicationFactory<Program>()
    .WithWebHostBuilder(builder =>
    {
        builder.ConfigureServices((context, services) =>
        {
            services.AddAssertableHttpClient(context.Configuration);
        });
    });
```

From there, a pragmatic order:

1. **Start with new tests.** Write every new endpoint test with the SDK, keep the old ones.
2. **Convert the tests that break most often.** They're where the failure output pays off first.
3. **Record, review, commit.** Pass `writeResponse: true` (or set `TestSdkSettings__WriteResponse=true`),
   run in Debug, read the generated snapshot like a code review, commit it.
4. **Collapse duplicated tests.** Five copies of the same test with different `DataRow`s become one
   method with `[DynamicRequestLocator]` and five request files.

For legacy APIs without any tests, there's also a bootstrap option. Register the test creator in the
API, exercise it manually or with an existing Postman collection, and it prints ready-made tests for
captured requests through the configured log action (for now, it handles `POST` requests with a body):

```csharp
builder.Services.AddTestCreator(builder.Configuration);   // writes to Debug output by default

app.UseTestCreator();
```

It's a starting point, not a finished suite, but it turns a session of clicking through an API into
test code you can edit.

## How to tell whether it's working

Pick numbers before you start, and look at them after a few sprints:

- **Time from red build to root cause.** The `curl` and `MemberPath` output should shrink it
  noticeably. If people still rebuild requests by hand, find out why.
- **Escaped contract changes.** Count production incidents caused by a changed field, status or header
  that the tests didn't notice. Full-response snapshots should drive this towards zero.
- **Lines of test code per endpoint.** Not a goal in itself, but a falling number with rising coverage
  means the plumbing is gone.
- **Filters per snapshot.** If ignore rules keep growing, the API probably returns too much volatile
  data, or the tests are being bent to stay green.

## Summary

- Plain asserts and assertion libraries are dependency-light and general; they miss headers, request
  context and endpoint contracts, and they scale with code, not data.
- General snapshot libraries are broader and framework-agnostic; they don't know about HTTP endpoints.
- AspNetCore.Simple.MsTest.Sdk specializes: **whole-response snapshots, `curl`-ready failures, contract
  validation and one test per JSON file**, at the price of **MSTest, JSON and file conventions**.
- It doesn't fit unit tests, load tests or non-JSON APIs.
- Migration works incrementally: one `AddAssertableHttpClient` line, new tests first, then the flaky ones.

The package is on [NuGet](https://www.nuget.org/packages/AspNetCore.Simple.MsTest.Sdk/), the source and
the extensive README are on [GitHub](https://github.com/RenePeuser/AspNetCore.Simple.MsTest.Sdk). If you
try it and hit one of the trade-offs above, open an issue. That's how most of the current features
started.
