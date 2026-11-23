---
title: AspNetCore.Simple.MsTest.Sdk — integration tests in one line
date: 2021-04-03
authors: rene
tags: [retrospective, testing, aspnetcore, dotnet]
excerpt: In April 2021 I got tired of writing the same HTTP plumbing for every API test. The result was a small helper library that went on to pass 700,000 NuGet downloads.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2021. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

On 3 April 2021 I pushed the "intial checkin" (typo included) of a repository called
`AspNetCore.Simple.MsTest.Sdk`. It contained a csproj and an empty `Class1.cs`. Five years later the
package has passed 700,000 downloads on NuGet (as of July 2026).

This post looks at where it came from and at the design decisions that held up.

## The problem: every API test looked the same

Earlier that year, in January 2021, I had started
[AspNetCore.Simple.Sdk](https://github.com/RenePeuser/AspNetCore.Simple.Sdk), a package that bundles
the server side of a Web API (authentication, security filters, CORS, Swagger, error handling) behind
a single `SimpleStartup` base class. Writing APIs got fast. Testing them didn't.

Every integration test went through the same mechanics:

1. start a test host with `WebApplicationFactory`;
2. build an HTTP request and load some test data;
3. send it;
4. check the status code;
5. deserialize the body;
6. compare it, property by property, with what I expected;
7. when it failed, work out *what* actually differed.

The first README of the package, from April 2021, still shows the "before" picture. Even the
simplified version needed a base class, a custom factory and an explicit compare step:

```csharp
[TestMethod]
public async Task Should_Return_My_Expected_Results()
{
    var persons = await Client.GetAsAsync<IEnumerable<Person>>("/myApi/persons");

    var expectedResult = EmbededFile.GetFileContentFrom("get-expected-person-result.json");

    Assert.That.ObjectsAreEqual(() => expectedResult, () => persons);
}
```

That was already better than a wall of `Assert.AreEqual` calls. But the three lines were identical
in every test. Only the URL, the type and the file name changed. If only the parameters change,
the rest belongs in a library.

## The one-liner

A few days later the assert helpers landed, and the docs from that time describe the goal:
*"you can assert a complete API call in one line"*:

```csharp
[TestMethod]
public Task Should_Return_Expected_Persons()
{
    return Client.AssertGetAsync<IEnumerable<Person>>("/myApi/persons", "myResult.json");
}
```

Four pieces of information, and nothing else:

- the **HTTP verb**, through the method name (`AssertGetAsync`, `AssertPostAsync`, `AssertPutAsync`,
  `AssertDeleteAsync`);
- the **response type**, as the generic argument;
- the **URL**;
- the **expected result**, as an embedded JSON file (or an inline JSON string).

For writes, the request body moved into a file too. That is the form most people know today:

```csharp
await Client.AssertPostAsync<UserResponse>(
    "api/v1/users",
    "CreateUser.json",
    "CreateUser.json");
```

## Design decision 1: test data lives in files

Putting requests and expected responses in embedded JSON files was the most important decision, and
it was a deliberate one:

- **Readable diffs in pull requests.** A changed contract shows up as a changed JSON file, not as
  a pile of edited `Assert` lines.
- **No sync between code and data.** The file *is* the expectation.
- **Non-developers can read it.** A JSON payload is something you can discuss with anyone who knows
  the API.

The library finds files by name inside the calling test assembly. One of the April 2021 commits adds
an explicit exception when a resource name is missing, because "file not found" without a hint about
*which* embedded resource was looked up wastes a lot of time.

## Design decision 2: compare the whole response, not cherry-picked fields

Traditional tests only check the fields someone remembered to assert. Comparing the full payload
flips that: a new field, a missing field, a changed value all fail the test.

Over time the snapshot grew from "the body" to "the whole HTTP response", including status code and
headers:

```json
{
  "Content": {
    "Headers": [
      { "Key": "Content-Type", "Value": [ "application/json; charset=utf-8" ] }
    ],
    "Value": { "Id": 1, "Name": "Son", "FirstName": "Goku", "Age": 99, "Emails": [] }
  },
  "StatusCode": "OK",
  "Headers": [],
  "TrailingHeaders": [],
  "IsSuccessStatusCode": true
}
```

That makes status code and content type part of the contract as well. A `200` turning into a `204`
fails the test, which is exactly what you want from a regression test.

Full comparison has one obvious enemy: values that change on every run, such as generated IDs or
timestamps. The answer is a difference filter, a plain function over the list of differences:

```csharp
private static IEnumerable<Difference> IgnoreId(ImmutableList<Difference> differences)
{
    foreach (var difference in differences)
    {
        if (difference.MemberPath == "content.value.id")
        {
            continue;
        }

        yield return difference;
    }
}
```

It can be registered globally or passed to a single assert. You opt out of what is volatile and
keep everything else strict.

## Design decision 3: a failing test should explain itself

In May 2021 I added the current and the expected result to the assert output. That small change
started a theme that runs through the whole history of the package: **the failure message is the
product.** A green test costs nothing. A red one costs whatever time it takes to understand it.

Today a snapshot mismatch reads like this (shortened):

```text
📸 SNAPSHOT MISMATCH

Method   : POST
Url      : http://localhost/api/v1/persons
Status   : 201 Created

┌────────────────────┬────────────────┬───────────────┬─────────────────┐
│ MemberPath         │ NewPerson.json │ CurrentResult │ MismatchType    │
├────────────────────┼────────────────┼───────────────┼─────────────────┤
│ content.value.name │ Son Test       │ Son           │ ValueDifference │
└────────────────────┴────────────────┴───────────────┴─────────────────┘

🔁 Reproduce Locally
curl \
--location \
--request POST 'http://localhost/api/v1/persons' \
--header 'Content-Type: application/json' \
--data-raw '{"id":1,"name":"Son","firstName":"Goku","age":42,"emails":[]}'
```

The exact path of the difference, the HTTP context, and a `curl` command you can paste into a
terminal (added in October 2022). Different failure types (snapshot mismatch, schema mismatch,
unexpected status code, content-type mismatch) get their own headers, so you know the category
before you read a single line.

:::tip
If your test framework makes you attach a debugger to understand a failure, the failure message is
the real bug. Fix that first.
:::

## How it grew

The core idea from 2021 never changed. What changed is how much of the remaining ceremony
disappeared:

| When | What |
|---|---|
| April 2021 | One-line `Assert{Verb}Async` helpers, embedded JSON files, first test-creator experiments |
| 2022 | Unauthorized/options asserts, custom difference functions, generated `curl` output, a test creator that turns live traffic into test files |
| 2025 | `DynamicRequestLocator`: one test case per JSON file, so adding a scenario means adding a file |
| 2026 | A fluent API that mirrors endpoint metadata, structured `because`/`fix` assertions for humans and AI, and a bundled Roslyn analyzer (`MSTESTSDK001`) that fails the build when a fluent chain never calls `ExecuteAsync()` |

The fluent style shows how far the "the test reads like the contract" idea went:

```csharp
[TestMethod]
[DynamicRequestLocator]
public Task Should_Create_User(string useCase)
{
    return Client.AssertPost("api/v1/users")
                 .AcceptsFromEmbeddedJson(useCase)
                 .Produces<UserResponse>(HttpStatusCode.OK)
                 .ExpectedResponseFromEmbeddedJson(useCase)
                 .ExecuteAsync();
}
```

That analyzer is a nice full circle for this series. A test library that protects its users with a
build-time rule is a small self-defending codebase on its own.

## Lessons that stuck

- **Extract what repeats, keep what varies visible.** The one-liner works because the URL, the type
  and the data are the only things a reader needs to see.
- **Files beat assertions for contracts.** JSON snapshots scale with scenarios. Assert statements
  scale with typing.
- **Strict by default, explicit opt-outs.** Comparing everything and filtering the volatile parts
  catches the regressions that cherry-picked asserts miss.
- **Invest in the red path.** A large share of five years of commits went into better failure
  output, not into new assert methods. I'd make the same call again.

What I'd do differently today: start with full HTTP response snapshots and the `curl` output from
day one instead of discovering them over two years. They are what makes a red test cheap.

The package is on [NuGet](https://www.nuget.org/packages/AspNetCore.Simple.MsTest.Sdk) and the code
is on [GitHub](https://github.com/RenePeuser/AspNetCore.Simple.MsTest.Sdk). There is also a short
[project page](/projects/testing-sdk/) with the feature overview.
