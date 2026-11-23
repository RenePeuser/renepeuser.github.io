---
title: Testing as a specific user — without pasting tokens into code
date: 2026-11-23
authors: rene
tags: [testing, security, aspnetcore]
excerpt: A bug only happens for one kind of user, so someone pastes a bearer token into a test and swaps the header on the shared client. How to run API tests as specific users, in-process and against deployed environments, without leaking tokens or breaking unrelated tests.
---


Sooner or later every API team gets a bug that only happens for certain users. A sales rep sees
orders they shouldn't see. A customer admin can't delete an address. The reflex is understandable:
grab that user's token from the browser, paste it into a test, run it.

```csharp
[TestMethod]
public async Task Reproduce_Address_Delete_Bug()
{
    Client.DefaultRequestHeaders.Add("Authorization", "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6...");

    var response = await Client.DeleteAsync("api/v1/customers/C-1000/addresses/2");

    Assert.AreEqual(HttpStatusCode.NoContent, response.StatusCode);
}
```

That single test has two serious problems, and only one of them is obvious.

## Problem 1: the token is a secret

A bearer token is a password with an expiry date. Committed to a repository, it's in the history
forever, in every clone, in every fork, in the pipeline logs that print the test source on failure.
Even an expired token tells an attacker your token format, your issuer and your claim names.

The rule I put in every guideline, in capital letters: **never put a token in test code.** Not
"temporarily", not "just for debugging". Fetch it at run time from something designed to hold
secrets.

## Problem 2: the shared client

The less obvious problem: `Client` is shared by every test in the assembly (see the
[base class post](/blog/2026-api-integration-test-base-class/)). `DefaultRequestHeaders.Add` changes
it for everyone. After this test runs, every following test either sends two `Authorization`
headers or runs as the wrong user, depending on what the server does with duplicates. And because
test order isn't guaranteed, the failures move around between runs.

Teams usually notice and try one of three fixes:

| Approach | Pro | Con |
|---|---|---|
| Set the header in the test, reset it at the end | Explicit, easy to read | A failing assert skips the reset, and every later test runs as the wrong user |
| Assert helpers reset the header after every call | Reset can't be forgotten | Multi-step tests must set the header again before every call, which is easy to miss |
| Reset in `[TestCleanup]` | Runs even after a failed assert | Breaks scenarios that set up a user once per class, and still shares state between parallel tests |

All three try to clean up after mutating shared state. The better fix is to **not mutate shared
state at all**.

## The fix: a client per user, a token per request

Instead of changing the shared client, give each test a client that *is* the user:

```csharp
protected static HttpClient ClientFor(string user) =>
    _factory.CreateDefaultClient(new Uri("https://localhost/"), new UserTokenHandler(TokenProvider, user));
```

```csharp
public sealed class UserTokenHandler(IUserTokenProvider tokens, string user) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var token = await tokens.GetTokenAsync(user, ct);
        request.Headers.Authorization = new AuthenticationHeaderValue(token.Scheme, token.Value);
        return await base.SendAsync(request, ct);
    }
}
```

Now the test reads like the scenario:

```csharp
[TestMethod]
public async Task Should_Not_Allow_Sales_Rep_To_See_Orders_Of_Other_Regions()
{
    using var salesRep = ClientFor(TestUsers.SalesRepNorth);

    var response = await salesRep.GetAsync($"api/v1/orders/{_orderInRegionSouth}");

    Assert.AreEqual(HttpStatusCode.Forbidden, response.StatusCode);
}
```

Nothing to reset. Nothing leaks into other tests. Parallel execution is safe. The header is set per
request, so even a long-running test always sends a fresh token.

## Where the token comes from

`IUserTokenProvider` has two implementations, one per hosting mode.

### In-process: test users, no real tokens

When the API runs inside `WebApplicationFactory`, I don't need real tokens at all. The test
authentication handler from the base class post maps a user name to a set of claims:

```csharp
public sealed class InProcessTokenProvider : IUserTokenProvider
{
    public ValueTask<UserToken> GetTokenAsync(string user, CancellationToken ct) =>
        ValueTask.FromResult(new UserToken("Test", user));
}
```

```csharp
public static class TestUsers
{
    public const string Admin         = "admin";
    public const string SalesRepNorth = "sales-rep-north";
    public const string ReadOnly      = "read-only";

    public static readonly IReadOnlyDictionary<string, Claim[]> Claims = new Dictionary<string, Claim[]>
    {
        [Admin]         = [new("sub", "u-admin"), new("role", "admin")],
        [SalesRepNorth] = [new("sub", "u-rep-n"), new("role", "sales-rep"), new("region", "north")],
        [ReadOnly]      = [new("sub", "u-read"),  new("scope", "orders:read")],
    };
}
```

The authorization policies and resource checks in the API stay real. Only "is this token valid"
is replaced. That's exactly the part that's not interesting for most user-specific bugs: the bug is
almost always in *what the user is allowed to do*, not in signature validation.

Reproducing a user bug then means: look at the real user's claims (roles, scopes, region, tenant),
add a test user with the same claims, write the test.

### Against a deployed environment: dedicated test users

When the tests run against a [deployed environment](/blog/2026-testing-against-multiple-environments/),
there's no way around real tokens. What I do:

- **Dedicated test users** in the identity provider, one per role you need to test, clearly named
  as test accounts and limited to non-production tenants or to read-only rights in production.
- **Their credentials live in a secret store** (Key Vault, Secrets Manager, the pipeline's secret
  variables). The test project only knows the secret *names*.
- **Tokens are fetched at run time and cached** until shortly before they expire.

```csharp
public sealed class RemoteTokenProvider(HttpClient identityClient, ITestUserSecrets secrets) : IUserTokenProvider
{
    private readonly ConcurrentDictionary<string, Lazy<Task<CachedToken>>> _cache = new();

    public async ValueTask<UserToken> GetTokenAsync(string user, CancellationToken ct)
    {
        var entry = _cache.GetOrAdd(user, u => new(() => FetchAsync(u, ct)));
        var cached = await entry.Value;

        if (cached.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
            return new UserToken("Bearer", cached.AccessToken);

        _cache.TryRemove(user, out _);          // expired: fetch a new one
        return await GetTokenAsync(user, ct);
    }

    private async Task<CachedToken> FetchAsync(string user, CancellationToken ct)
    {
        var credentials = await secrets.GetAsync(user, ct);   // from the secret store, never from code

        using var response = await identityClient.PostAsync("oauth/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"]    = "client_credentials",
            ["client_id"]     = credentials.ClientId,
            ["client_secret"] = credentials.ClientSecret,
            ["audience"]      = "https://api.shop.example.com"
        }), ct);

        response.EnsureSuccessStatusCode();
        var token = (await response.Content.ReadFromJsonAsync<TokenResponse>(ct))!;
        return new CachedToken(token.AccessToken, DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn));
    }
}
```

The example uses client credentials, one client per test persona, which works well when the API
authorizes by scopes and roles carried in the token. If your API needs a real *user* token (with a
user's subject and group memberships), the identity provider decides what's possible: some offer a
token endpoint for test users, some support token exchange, some only allow interactive logins. The
legacy password grant still works with some providers, but OAuth 2.1 drops it, so I wouldn't build
anything new on it.

:::caution[Cache tokens]
Without caching, every test fetches a new token. Depending on your identity provider that's slow,
rate-limited, or billed per token. One token per user per run (refreshed only near expiry) is
usually enough.
:::

## What about a "give me a token for user X" endpoint?

I've seen teams add `GET api/test/users/{id}/token` to their API so tests can impersonate anyone. It's
convenient, and it's a back door with an HTTP interface. If you really need it, it must never be
mapped outside non-production environments, it must be protected itself, and its existence should
be checked by a test that runs against production and expects a `404`.

## The tests worth writing per user

With clients per user, the interesting cases become cheap:

```csharp
[TestMethod]
public async Task Should_Return_401_When_Token_Is_Missing() =>
    Assert.AreEqual(HttpStatusCode.Unauthorized, (await AnonymousClient.GetAsync(Url)).StatusCode);

[TestMethod]
public async Task Should_Return_403_When_Token_Lacks_Write_Scope()
{
    using var reader = ClientFor(TestUsers.ReadOnly);
    Assert.AreEqual(HttpStatusCode.Forbidden, (await reader.DeleteAsync(Url)).StatusCode);
}

[TestMethod]
public async Task Should_Return_403_When_Customer_Belongs_To_Another_Region()
{
    using var salesRep = ClientFor(TestUsers.SalesRepNorth);
    Assert.AreEqual(HttpStatusCode.Forbidden, (await salesRep.GetAsync(UrlInRegionSouth)).StatusCode);
}
```

The third one is the one most suites miss. **"Has the scope" is not the same as "may access this
resource".** Scope checks protect endpoints; resource checks protect data. Bugs in the second
category are the ones that end up in security incident reports.

## Pitfalls

**Tokens in test output.** If your test logs requests (for example as
[curl commands](/blog/2026-from-postman-to-csharp-and-back/)), redact the `Authorization` header by
default.

**Test users with too many rights.** A test user that's an admin "because it's easier" makes every
permission test meaningless. Each persona gets exactly the rights of the role it represents.

**Drifting test users.** Someone changes the roles of a test user in the identity provider, and half
the permission tests fail with no code change. Add a "who am I" smoke test per persona that checks
the claims the API sees, so a drifted user is reported as such.

**Expiry in long runs.** A token fetched in `AssemblyInitialize` can expire before the last test runs.
Setting the header per request from a cache that refreshes near expiry avoids that.

## Make it enforceable

- **Secret scanning** in the pipeline (and as a pre-commit hook) catches pasted JWTs. They're easy to
  detect: three base64url segments starting with `eyJ`.
- **Ban mutation of the shared client.** A banned-API rule for `HttpHeaders.Add` in the test project
  is too broad, but an architecture test that fails when a test class touches
  `Client.DefaultRequestHeaders` is a few lines with Roslyn or a simple source scan. That's the
  [self-defending](/blog/2026-self-defending-codebases/) version of "please don't".

## Summary

- **Never put tokens in test code.** Fetch them at run time from a secret store and cache them.
- **Don't mutate the shared client.** Create a client per user with a handler that sets the token
  per request.
- **In-process**, use named test users with realistic claims and keep authorization policies real.
- **Against deployed environments**, use dedicated, least-privilege test users whose credentials live
  in a secret store.
- Test **401, 403 for missing scope and 403 for foreign resources**. The last one is where the
  serious bugs hide.
