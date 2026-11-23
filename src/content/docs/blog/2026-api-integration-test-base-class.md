---
title: One job only — a base class for API integration tests
date: 2026-11-23
authors: rene
tags: [testing, aspnetcore, dotnet]
excerpt: Most integration test base classes start as "host the API" and end as a 2,000-line junk drawer of test data helpers. A WebApplicationFactory-based base class that starts the API once, hands out clients and does nothing else.
---


Every API test suite I've joined had a base class. And almost every one of them had the same
history: it started with ten lines that host the API, and two years later it contained
`CreateCustomerAsync`, `CreateOrderWithThreeLinesAsync`, `SeedProductsForTenantB` and a
`static bool _initialized` that nobody dared to touch.

The base class itself is a good idea. What goes wrong is its **responsibility**. This post shows the
base class I use today: `WebApplicationFactory` underneath, the API started once per test run, and
exactly one job.

## The problem: the base class that knows everything

Here's a shortened version of what I typically find:

```csharp
public abstract class ApiTestBase
{
    protected HttpClient Client = null!;
    protected Customer DefaultCustomer = null!;
    protected Product DefaultProduct = null!;

    [TestInitialize]
    public async Task BaseInitializeAsync()
    {
        var factory = new WebApplicationFactory<Program>();   // new host for every single test
        Client = factory.CreateClient();
        Client.DefaultRequestHeaders.Add("Authorization", $"Bearer {await GetTokenAsync()}");

        DefaultCustomer = await CreateCustomerAsync("Test customer");
        DefaultProduct  = await CreateProductAsync("Test product", price: 9.99m);
    }

    protected async Task<Order> CreateOrderAsync(int lines = 1) { /* ... */ }
    protected async Task<Invoice> CreateInvoiceForOrderAsync(Order order) { /* ... */ }
    // ... 40 more helpers
}
```

Three problems hide in there:

1. **The API starts for every test.** Building the host, running startup, warming up DI and
   connecting to whatever the app connects to on startup costs real seconds. Multiply by 800 tests.
2. **Every test pays for data it doesn't use.** A test for `GET /products` still creates a customer
   and a product first, because the base class does it for everyone.
3. **Tests depend on invisible state.** When a test reads `DefaultCustomer`, you can't see where it
   came from, what it looks like, or which other test changed it. Change the base class and 300
   tests turn red at once.

The last point is the real killer. The base class has become a second, undocumented test-data
framework, and every test is coupled to it.

## The rule: start the app, give access, nothing else

The rule I put into the guidelines of every team I work with is short:

> A test base class has exactly one responsibility: **start the API and give tests access to it.**
> It never creates domain data and never cleans it up.

Test data belongs to the test (or to small, reusable helpers the test calls explicitly). We'll get to
that in the [next post about GET, POST and DELETE patterns](/blog/2026-api-test-patterns-get-post-delete/).

## The base class

Here's the whole thing, for .NET 10 and MSTest:

```csharp
namespace MyShop.Api.Tests;

[TestClass]
public abstract class ApiTestBase
{
    private static ApiFactory _factory = null!;

    protected static HttpClient Client { get; private set; } = null!;
    protected static HttpClient AnonymousClient { get; private set; } = null!;
    protected static IServiceProvider Services => _factory.Services;

    [AssemblyInitialize]
    public static void StartApi(TestContext _)
    {
        _factory = new ApiFactory();

        // Authenticated by default: most tests are about behaviour, not about auth.
        Client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,      // a redirect is a result you want to see, not follow
            BaseAddress = new Uri("https://localhost/")
        });
        Client.DefaultRequestHeaders.Authorization = new("Test", TestUsers.Default);

        // No credentials at all: for the 401 tests.
        AnonymousClient = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            BaseAddress = new Uri("https://localhost/")
        });
    }

    [AssemblyCleanup]
    public static async Task StopApiAsync()
    {
        Client.Dispose();
        AnonymousClient.Dispose();
        await _factory.DisposeAsync();
    }
}
```

And the factory, where the test-specific wiring lives:

```csharp
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("IntegrationTest");

        // Settings: UseSetting is applied early enough to be seen by Program.cs.
        builder.UseSetting("Features:SendEmails", "false");

        builder.ConfigureTestServices(services =>
        {
            // Replace the real authentication with a deterministic test scheme.
            services.AddAuthentication(TestAuthHandler.Scheme)
                    .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.Scheme, _ => { });

            // Replace only what you can't run in a test: external systems with side effects.
            services.RemoveAll<IEmailSender>();
            services.AddSingleton<IEmailSender, NullEmailSender>();
        });
    }
}
```

A few details that matter more than they look:

- **`[AssemblyInitialize]` lives in the base class.** MSTest runs it once per test assembly, no
  matter how many classes derive from the base. The API starts once and every test class shares
  it. In my experience that's the single biggest speed-up an integration suite can get.
- **`Program` must be visible to the test project.** With .NET 10 the SDK generates a public
  `partial class Program` for top-level statements. On older versions add
  `public partial class Program;` at the end of `Program.cs`.
- **Reference `Microsoft.AspNetCore.Mvc.Testing` explicitly** in the test project. If it only comes
  in transitively through some helper package, you can end up with a missing `*.deps.json` error and
  tests that silently don't start.
- **`ConfigureTestServices` runs after the app's own registrations**, so it wins. That's the place
  for replacements, not `ConfigureServices`.

## Authentication without a real identity provider

The default client sends an `Authorization: Test <user>` header. A small handler turns that into a
`ClaimsPrincipal`:

```csharp
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!AuthenticationHeaderValue.TryParse(Request.Headers.Authorization, out var header)
            || header.Scheme != Scheme
            || !TestUsers.TryGet(header.Parameter, out var user))
        {
            return Task.FromResult(AuthenticateResult.NoResult());   // → 401 from the pipeline
        }

        var identity = new ClaimsIdentity(user.Claims, Scheme);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
```

```csharp
public static class TestUsers
{
    public const string Default = "order-admin";
    public const string ReadOnly = "order-reader";

    private static readonly Dictionary<string, TestUser> Users = new()
    {
        [Default]  = new([new("sub", "u-1"), new("scope", "orders:read orders:write")]),
        [ReadOnly] = new([new("sub", "u-2"), new("scope", "orders:read")]),
    };

    public static bool TryGet(string? name, [NotNullWhen(true)] out TestUser? user) =>
        Users.TryGetValue(name ?? "", out user);
}

public sealed record TestUser(IReadOnlyList<Claim> Claims);
```

This keeps your authorization policies real. Only the token validation is replaced, so a missing
scope still produces a `403`. If you need real tokens from a real identity provider, for example when
testing a deployed environment, that's a separate topic:
[testing with specific user tokens](/blog/2026-testing-with-specific-user-tokens/).

## What a test looks like now

```csharp
[TestClass]
public sealed class GetProducts_Tests : ApiTestBase
{
    [TestMethod]
    public async Task Should_Return_401_When_No_Token_Is_Sent()
    {
        var response = await AnonymousClient.GetAsync("api/v1/products");

        Assert.AreEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [TestMethod]
    public async Task Should_Return_Product_That_Was_Created()
    {
        var created = await Client.PostAsJsonAsync("api/v1/products", new { Name = "Mug", Price = 9.99m });
        var product = await created.Content.ReadFromJsonAsync<ProductResponse>();

        var response = await Client.GetFromJsonAsync<ProductResponse>($"api/v1/products/{product!.Id}");

        Assert.AreEqual(product, response);
    }
}
```

Everything the test depends on is in the test. The route is visible, the data is visible, and the
base class contributes nothing but `Client`. For full-response comparison and readable diffs I use
my own [assertion library](/projects/testing-sdk/), but the base class doesn't care which assertion
style you pick.

## Hooks, but only technical ones

Sometimes a test assembly needs different wiring, for example an in-memory queue instead of a real
broker. Offer a hook for that, but keep it technical:

```csharp
public sealed class ApiFactory(Action<IServiceCollection>? configureTestServices = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // ... as above
        builder.ConfigureTestServices(services => configureTestServices?.Invoke(services));
    }
}
```

What I never accept in the base class: `SetupAsync` methods that create orders, `[TestCleanup]`
methods that delete "everything the test created", or properties like `DefaultCustomer`.

## Comparing the options

| | New factory per test | Factory per test class | One factory per assembly |
|---|---|---|---|
| Startup cost | ❌ paid per test | ⚠️ paid per class | ✅ paid once |
| Isolation of app state (singletons, caches) | ✅ full | ⚠️ per class | ❌ shared, tests must not rely on it |
| Different configuration per test | ✅ trivial | ✅ easy | ⚠️ needs a second factory |
| Works with parallel test execution | ✅ | ✅ | ✅ if test data is isolated |
| Feels like production | ❌ cold start every time | ⚠️ | ✅ one long-running app, like a real server |

I default to one factory per assembly. When a handful of tests genuinely need different
configuration (a feature flag off, a different tenant mode), they get their **own** factory instance
in their own class, not a parameter on the shared one.

## Pitfalls

**Environment variables.** It's tempting to switch behaviour with
`Environment.SetEnvironmentVariable` before creating the factory. Environment variables are
process-wide, survive the test, and leak into every test that runs after or in parallel. If you
really must, reset them in `Dispose`. Better: use `builder.UseSetting(...)`, which is scoped to that
host.

**Mutating the shared client.** `Client.DefaultRequestHeaders` is shared by every test in the
assembly. A test that swaps the `Authorization` header and forgets to restore it breaks tests that
have nothing to do with it, and only when the order of execution is unlucky. Set per-request headers
on an `HttpRequestMessage`, or create a dedicated client.

**`ConfigureAppConfiguration` with minimal hosting.** Configuration added there can arrive after
`Program.cs` has already read the value (for example, to decide which services to register). If a
setting doesn't seem to apply, switch to `UseSetting`.

**Static state in the app.** With one host per assembly, a static cache or a singleton with mutable
state is shared across all tests. That's not a test problem. It's a production problem your tests
just found.

## Make it stick

Conventions erode, so I enforce this one with a small architecture test:

```csharp
[TestMethod]
public void Should_Not_Let_Test_Base_Classes_Depend_On_Domain_Contracts()
{
    var result = Types.InAssembly(typeof(ApiTestBase).Assembly)
        .That().AreAbstract().And().HaveNameEndingWith("Base")
        .ShouldNot().HaveDependencyOnAny("MyShop.Orders.Contracts", "MyShop.Catalog.Contracts")
        .GetResult();

    Assert.IsTrue(result.IsSuccessful,
        $"Base classes host the API, they don't create data: {string.Join(", ", result.FailingTypeNames ?? [])}");
}
```

It's crude, but it stops the first `CreateOrderAsync` from sneaking into the base class. That's the
idea behind [self-defending codebases](/blog/2026-self-defending-codebases/) applied to test code,
which deserves the same quality standards as production code.

Also keep an eye on the **duration of the whole suite** in your pipeline. If it suddenly doubles, the
first suspect is a new class that creates its own factory without a good reason.

## Summary

- A test base class has **one job**: start the API once and hand out clients. No test data, no
  domain cleanup.
- Use `WebApplicationFactory<Program>` with `[AssemblyInitialize]` so the API starts **once per
  test run**.
- Replace only what you can't run in a test (auth validation, e-mail, external systems) via
  `ConfigureTestServices`. Keep authorization policies real.
- Provide an **authenticated and an anonymous client**, and never mutate shared headers in a test.
- Prefer `UseSetting` over environment variables, and **enforce** the "no domain code in base
  classes" rule with an architecture test.
