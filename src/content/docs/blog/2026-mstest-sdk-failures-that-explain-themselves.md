---
title: Test failures that explain themselves — diffs, curl and contract checks in AspNetCore.Simple.MsTest.Sdk
date: 2026-11-24
authors: rene
tags: [dotnet, testing, aspnetcore, open-source, ai]
excerpt: A bare "Expected:<Son>. Actual:<>." is where debugging starts, not where it ends. How AspNetCore.Simple.MsTest.Sdk turns a failing API test into a categorized report with the exact JSON path, the HTTP context, a ready-to-run curl and a suggested fix, and why it checks your test against the endpoint's own contract.
---

A red API test in CI usually costs more than the bug behind it. The log says
`Assert.AreEqual failed. Expected:<Son>. Actual:<Son Test>.`, and then the actual work starts: which
request was sent, against which URL, with which body? Which field, in which nested object, in which
array element? Can I reproduce it outside the test runner?

[AspNetCore.Simple.MsTest.Sdk](https://github.com/RenePeuser/AspNetCore.Simple.MsTest.Sdk) was built
around the opposite idea: **a failure should already contain the answer to all of those questions.**
In [part one](/blog/2026-mstest-sdk-api-tests-in-one-line/) I showed how one call replaces a whole
test. This part is about what that call prints when it fails, and about the checks it runs before it
even compares a body.

## Six kinds of failure, six different headers

Not every red test means the same thing. A changed value is business logic; a missing property is a
contract change; a wrong status code is often a test that asserts the wrong path. The SDK distinguishes
them and gives each its own header:

| Failure | When it occurs | What it usually means |
|---|---|---|
| 📸 **SNAPSHOT MISMATCH** | Values differ | Business logic produces different values |
| 📋 **SCHEMA MISMATCH** | Properties missing or added, types differ | The API contract changed, possibly breaking |
| 🚫 **UNEXPECTED STATUS CODE** | Wrong HTTP status | Validation, auth or routing behaves differently |
| 📄 **CONTENT TYPE MISMATCH** | Response isn't JSON | An HTML error page, a proxy, a misconfigured formatter |
| ❌ **ASSERT METHOD MISMATCH** | Success assert with an error snapshot, or vice versa | The test is written for the wrong path |
| ❌ **HTTP RESPONSE TYPE MISMATCH** | Declared test type doesn't match the endpoint | The test or the endpoint metadata is wrong |

All of them follow the same structure: header, failure details, test information, HTTP context,
problem details, suggested fix, curl. You learn to read one, and you can read all of them.

The assertion pipeline also fails fast and in order: status code first, then content type, then JSON
structure, then the deep comparison. A `500` with an HTML error page shows up as a status problem,
not as forty meaningless JSON differences.

## Anatomy of a snapshot mismatch

This is real output from the repository's sample tests, trimmed a little:

```text
══════════════════════════════════════════════════════════════
📸 SNAPSHOT MISMATCH
══════════════════════════════════════════════════════════════

⚠️ Failure Details
──────────────────────────────────────────────────────────────

JSON values differ from the expected snapshot.
All properties exist but have different values.

📦 Test Information
──────────────────────────────────────────────────────────────

Project    : MinimalApi.Test
Class      : MinimalApi.Test.Api.Persons.PersonEndpointsTests
Method     : Should_Be_Able_To_Post_A_Person_Object
Line       : 65
File       : file:///.../src/MinimalApi.Test/Api/Persons/PersonEndpointsTests.cs:65

🌍 HTTP
──────────────────────────────────────────────────────────────

Method   : POST
Url      : http://localhost/api/v1/persons
Status   : 201 Created
Body     : {"id":1,"name":"Son","firstName":"Goku","age":42,"emails":[]}
Response : NewPerson.json

🔍 Differences (Count 1)
──────────────────────────────────────────────────────────────

┌────────────────────┬────────────────┬───────────────┬─────────────────┐
│ MemberPath         │ NewPerson.json │ CurrentResult │ MismatchType    │
├────────────────────┼────────────────┼───────────────┼─────────────────┤
│ content.value.name │ Son Test       │ Son           │ ValueDifference │
└────────────────────┴────────────────┴───────────────┴─────────────────┘

🔁 Reproduce Locally
──────────────────────────────────────────────────────────────

curl \
--location \
--request POST 'http://localhost/api/v1/persons' \
--header 'Content-Type: application/json' \
--data-raw '{"id":1,"name":"Son","firstName":"Goku","age":42,"emails":[]}'
```

Each block answers one debugging question:

- **Test Information** — where. The `File` line is a `file://` URI with the line number; Rider, VS Code
  and Visual Studio make it clickable, so you jump straight to the failing assert.
- **HTTP** — which call. Method, URL, status, the body that was actually sent and the snapshot file it
  was compared to.
- **Differences** — what. `MemberPath` is the camelCase JSON path, deep enough to point at
  `content.value.emails[1].type`. It's also exactly the string you'd put into a `differenceFilter` if
  the field turns out to be volatile.
- **Reproduce Locally** — how to replay it. Paste the `curl` into a terminal against your local
  instance and you see the same response.

Two details make the diff table readable on real payloads. Mismatch types distinguish
`ValueDifference` from `MissingInFirst` and `MissingInSecond`, so "changed" and "gone" never look the
same. And when an array differs only in length, the SDK collapses the element-by-element noise into one
row:

```text
| content.value.emails | [] (0 items) | [2 item(s)] | MissingInFirst |
```

Element-level rows only appear when elements actually differ.

The `curl` doesn't leak credentials either. A bearer token is printed as
`Authorization: Bearer Sorry i am secret :)` unless you explicitly set `ShowTokenInCurl = true` for a
local debugging session. Test logs end up in CI artifacts and chat threads; tokens shouldn't.

## The test is checked against the endpoint's contract

The most underrated part of the SDK runs before any comparison. It looks up the endpoint behind the URL
in the host's endpoint metadata and checks that **your test asks for what the endpoint declares**.

Take a minimal API endpoint with its metadata:

```csharp
routeBuilder.MapPost("persons", (Person person) =>
            {
                if (string.IsNullOrWhiteSpace(person.Name))
                {
                    return Results.BadRequest(new { StatusCode = 400, Message = "Invalid request" });
                }

                return Results.Created($"persons/{person.Id}", person);
            })
            .Accepts<Person>(MediaTypeNames.Application.Json)
            .Produces<Person>(StatusCodes.Status201Created)
            .Produces<ProblemDetails>(StatusCodes.Status400BadRequest);
```

A test that declares the wrong response type fails with the endpoint's own declaration next to it, and
with a corrected call to copy:

```text
❌ HTTP RESPONSE TYPE MISMATCH

🔍 Type Validation
┌─────────────┬────────────────────────┬────────────────────┬───────┐
│ Status Code │ Endpoint Response Type │ Declared Test Type │ Match │
├─────────────┼────────────────────────┼────────────────────┼───────┤
│ 201         │ Person                 │ UnknownResponse    │ ✗     │
└─────────────┴────────────────────────┴────────────────────┴───────┘

Endpoint defines: 201 → Person

✅ Suggested Fix
return Client.AssertPostAsync<Person>("api/v1/persons", ...);
```

The validation has three tiers, so it works on real-world codebases where metadata is incomplete:

1. **Declared metadata.** `[ProducesResponseType]` on controllers or `.Produces<T>()` on minimal APIs.
   Success asserts are checked against the 2xx entries, `AsErrorAsync` asserts against 4xx/5xx.
2. **The expected snapshot.** Without metadata, the SDK reads `StatusCode` from the expected JSON
   (both `500` and `"InternalServerError"` work) and validates against that.
3. **The assert method itself.** A success assert whose snapshot holds an error status fails with
   `ASSERT METHOD MISMATCH - SUCCESS EXPECTED` and two concrete options: switch to
   `AssertPostAsErrorAsync()`, or fix the expected status.

This catches a whole class of tests that pass for the wrong reason: a test for the happy path that has
quietly been asserting a `400` since someone recorded the snapshot with invalid input, or
`ProblemDetails` versus `ValidationProblemDetails` confusion.

The same logic covers `204 No Content`. Non-generic asserts mean "no body":

```csharp
// ❌ The endpoint returns 200 with a body; the non-generic call expects 204
await Client.AssertPostAsync("api/v1/items", "NewItem.json");

// ✅ The generic call states the response type
await Client.AssertPostAsync<CreateItemResponse>("api/v1/items", "NewItem.json", "Expected.json");
```

And a misspelled URL or a wrong verb is reported as "endpoint not found", not as a green test that
happened to expect a `404`.

When the check is in the way, for example against an external API without metadata, switch it off per
call with `skipEndpointValidation: true`. That's different from `ignoreResponse: true`, which keeps the
contract check and skips only the body comparison:

| | `ignoreResponse: true` | `skipEndpointValidation: true` |
|---|---|---|
| Endpoint must exist | Yes | No |
| Response type checked against the endpoint | Yes | No |
| Body compared to the snapshot | No | Yes, if an expected result is given |
| Typical use | Intermediate steps of a process test | External APIs, legacy endpoints |

## Failures for machines: Human, AI and Hybrid output

The boxed output is optimized for people. An AI coding agent that has to fix a failing test does better
with structure, so the same failure can be emitted as JSON:

```json
{
  "errorCode": "HTTP_SNAPSHOT_MISMATCH",
  "method": "Should_Create_Person",
  "file": "D:\\path\\to\\test.cs",
  "line": 65,
  "differences": [
    { "path": "content.value.name", "expected": "Goku", "actual": "Son", "mismatchType": "ValueDifference" }
  ],
  "suggestedFix": "Update the expected value at path 'content.value.name' from 'Goku' to 'Son'.",
  "httpMethod": "POST",
  "url": "http://localhost/api/v1/persons",
  "expectedStatusCode": "Created",
  "actualStatusCode": "Created"
}
```

The mode is a setting, so it can differ between your machine and the pipeline without touching code:

```yaml
- name: Run Tests
  env:
    TestSdkSettings__OutputMode: Hybrid       # Human, Ai or Hybrid
    TestSdkSettings__OutputRendering: PlainText
  run: dotnet test --logger trx
```

`OutputRendering` solves a very practical CI problem. The TRX logger writes ANSI colour codes and emojis
as escaped text (`\u001b[1;31m\ud83d\udccb SCHEMA MISMATCH`), which ruins Markdown test summaries built
from the TRX file. `PlainText` keeps borders, tables and sections and drops only colour and emojis.
I've written more about why structured failures matter for agents in
[AI-friendly tests](/blog/2026-ai-friendly-tests/).

## The same discipline for plain assertions: `Assert.That`

Not every check is an HTTP call. For the rest, the SDK ships `Assert.That.*` extensions with two
mandatory parameters, `because` and `fix`:

```csharp
Assert.That.IsTrue(user.IsActive && user.IsVerified,
                   because: "Active and verified users should have full access",
                   fix: "Activate the user account in the admin panel");
```

The failure prints the condition as code (captured with `CallerArgumentExpression`), the reason and
the suggested fix:

```text
⚠️  CONDITION FAILED - EXPECTED TRUE

Condition: user.IsActive && user.IsVerified
Result     : False
Expected   : True

💭 Context (Why)
Active and verified users should have full access

✅ Suggested Fix (How)
Activate the user account in the admin panel
```

Making `because` and `fix` mandatory is the point. Writing them forces the author to think about what
the assertion protects, and whoever reads the failure later, human or agent, doesn't have to
reverse-engineer it. The set covers booleans, nulls, equality, types, numbers, strings, collections,
exceptions (sync and async), dates and a deep `ObjectsAreEqual` with the same `MemberPath` diff as the
HTTP asserts.

For your own exceptions, derive from `TestErrorHandler<TException>` and register it; the SDK asks your
handler before its catch-all:

```csharp
public sealed class DomainRuleErrorHandler : TestErrorHandler<DomainRuleViolatedException>
{
    protected override Task<string> HandleExceptionAsync(IObjectAssertContext context,
                                                         DomainRuleViolatedException exception)
        => Task.FromResult($"DOMAIN RULE VIOLATED: {exception.Message}");
}

services.AddSingleton<ITestErrorHandler, DomainRuleErrorHandler>();
```

## Pitfalls

- **Copying the suggested fix blindly.** "Update the expected value from 'Goku' to 'Son'" is the right
  fix only if the new behaviour is correct. The output tells you *what* changed; whether it should have
  changed is still your call.
- **Switching endpoint validation off globally.** `TestSdkSettings.SkipEndpointValidation` exists, but
  it removes the check that catches wrong-path tests. Use it per call for the endpoints that need it.
- **Printing tokens in CI.** `ShowTokenInCurl` is for local debugging. Keep it out of shared settings.
- **Fighting the TRX encoding.** If your test summary shows `\u001b` sequences, it's not a broken
  logger. Set `OutputRendering` to `PlainText` in the pipeline.

## Summary

- Failures are **categorized**: snapshot, schema, status, content type, assert method, response type.
  The header alone tells you what kind of problem you have.
- Every failure carries the **clickable test location**, the **HTTP context**, the **exact JSON path**
  of each difference and a **ready-to-run `curl`** with the token masked.
- The SDK checks your test **against the endpoint's declared contract** in three tiers, which catches
  tests that pass for the wrong reason.
- **Human, AI and Hybrid** output modes and a **PlainText** rendering make the same failure useful in
  the IDE, for an agent and in a CI summary.
- `Assert.That.*` brings mandatory `because`/`fix` context to every other assertion.

Next: [the fluent API and the analyzers that guard it](/blog/2026-mstest-sdk-fluent-api-and-analyzers/),
where the compiler stops you from writing a test that never runs.
