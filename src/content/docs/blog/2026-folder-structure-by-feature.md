---
title: "Folder structure: by technology, by domain, by feature or by feature and action?"
date: 2026-11-25
draft: true
authors: rene
tags: [architecture, aspnetcore, dotnet]
excerpt: Four ways to lay out the folders of an ASP.NET Core API, what each one optimizes for and where each one breaks. Plus the structure I recommend today, the namespace trick that keeps it readable, and how registration flows from Program.cs down to a single endpoint.
---

:::note[Series]
Part of the series [*Architecture in practice*](/series/architecture-in-practice/).
:::

Folder structure is the one architecture decision every developer on the team sees every day. It's
also the one that's hardest to change later, because moving 400 files breaks every open pull
request. Still, most teams pick a structure by copying the last project, or the template that
`dotnet new` produced.

Over the years I've worked with four variants, sometimes several in the same company. This post
compares them with the same example: a shop API with orders, versioned as `V1`, with the actions
*place*, *get by id*, *search* and *cancel*. At the end I'll say which one I recommend and why.

If you haven't read it yet, [*Vertical slices — why I cut the code by feature*](/blog/2026-vertical-slices/)
explains the reasoning behind slicing in general. This post is about the concrete folders.

## Option 1: by technology

```text
MyShop.Api
├── Controllers
│   └── OrdersController.cs
├── Services
│   └── OrderService.cs
├── Models
│   ├── OrderDto.cs
│   └── PlaceOrderRequest.cs
├── Validators
└── Repositories
```

This is the `dotnet new webapi` default and what most tutorials show.

**Pros:** everyone knows it. For a small API, it's quick to start with.

**Cons:** the first layer tells you nothing about what the API does. Everything belonging to one
feature is scattered. Classes in `Services` grow with every feature. There's no natural place for
versioning: does `V2` go into `Controllers/V2`, `Models/V2`, `Services/V2`?

## Option 2: by domain, then by technology

```text
MyShop.Api
└── Api
    └── Orders
        └── V1
            ├── Controllers
            │   └── OrdersController.cs
            ├── Models
            ├── Commands
            │   └── PlaceOrderCommand.cs
            └── Queries
                ├── GetOrderByIdQuery.cs
                └── SearchOrdersQuery.cs
```

The first layers are domains and versions. Technology comes last.

**Pros:** a clear entry point per domain. The folder tree shows which domains the API provides. If
someone reports wrong data, you can jump straight to `Queries`. Versioning has an obvious place.

**Cons:** inside a domain, all actions still share folders. `Models` mixes the request of *place*
with the response of *search*. One controller still has every action, and commands and queries for
different use cases live next to each other.

This was the structure I used for years, and it's a big step up from option 1. It starts to hurt
when a domain grows beyond five or six actions.

## Option 3: by feature, with one shared controller

```text
MyShop.Api
└── Api
    └── Orders
        ├── OrdersController.cs        ← one facade with all CRUD actions
        └── V1
            ├── Place
            │   ├── PlaceOrderRequest.cs
            │   └── PlaceOrderCommand.cs
            ├── GetById
            ├── Search
            └── Cancel
```

Each feature gets its own scope, and one controller stays as the HTTP facade.

**Pros:** no more mixing of request types between actions. It forces separation of concerns, because
`Place` simply can't see `Search`'s models without an explicit `using`. The controller gives a
compact overview of the routes.

**Cons:** the HTTP part is separated from the feature it belongs to. Change the request of *place*
and you edit two places: the feature folder and the controller. The controller also keeps growing,
and it needs every feature's dependencies injected.

## Option 4: by feature and action (one endpoint per folder)

```text
MyShop.Api
└── Api
    └── Orders
        └── V1
            ├── _Shared_
            │   ├── Order.cs
            │   ├── OrderEntityMapper.cs
            │   └── OrderSettings.cs
            ├── Place
            │   ├── Commands
            │   │   └── PlaceOrderCommand.cs
            │   ├── Documentations
            │   │   ├── Summary.md
            │   │   └── Description.md
            │   ├── Endpoints
            │   │   └── PlaceOrderEndpoint.cs
            │   ├── Mappers
            │   │   └── PlaceOrderRequestMapper.cs
            │   ├── Requests
            │   │   └── PlaceOrderRequest.cs
            │   ├── Responses
            │   │   └── PlaceOrderResponse.cs
            │   ├── Validations
            │   │   └── PlaceOrderRequestValidator.cs
            │   └── PlaceOrderStartup.cs
            ├── GetById
            ├── Search
            ├── Cancel
            └── Startup.cs
```

Every action is a complete, self-contained unit, including its HTTP endpoint. This is what Minimal
APIs make natural: no controller class that forces you to group actions together.

**Pros:** maximum isolation. Everything about *place order* is in one folder, including its route,
documentation and validation. Adding an endpoint means adding a folder. Removing one means deleting
a folder and one registration line. Shared code is visible as such in `_Shared_`.

**Cons:** more files and folders. For trivial endpoints the subfolders can feel like ceremony. And
because every action is isolated, you quickly run into the "share or copy?" question for similar
code. A team that doesn't answer that question ends up with either copy-paste or a bloated
`_Shared_` folder.

:::tip[Subfolders inside an action are optional]
For a slice with five files, `Commands/`, `Requests/` and `Responses/` subfolders are overkill. I
use them once an action has more than about eight files, and keep the files flat below that. The
important level is the action folder, not what's inside.
:::

## Comparison

| | By technology | Domain → technology | Feature + shared controller | Feature + action |
|---|---|---|---|---|
| First layer tells what the API does | ❌ | ✅ | ✅ | ✅ |
| All code of one use case in one place | ❌ | ❌ | ⚠️ except HTTP | ✅ |
| Models shared between actions | always | often | rarely | only via `_Shared_` |
| Natural place for versions | ❌ | ✅ | ✅ | ✅ |
| Add / remove an endpoint | touch 4+ folders | touch 3 folders | touch 2 places | one folder |
| Number of files | lowest | low | medium | highest |
| Best fit | tiny APIs, demos | controller-based APIs | migrating from controllers | Minimal APIs, growing APIs |

## My recommendation

For any API that will live longer than a year or be worked on by more than one team: **option 4,
feature and action**, with Minimal APIs.

For an existing controller-based API: **don't migrate half of it.** In one set of guidelines I've
worked with, the rule was explicit: if a solution uses the old structure, new code follows the old
structure until the whole solution is migrated. I agree. A codebase with two structures is harder to
navigate than one with the "worse" structure applied consistently.

Option 3 is a reasonable intermediate step if you're stuck with controllers for a while, for example
because tooling like client generation depends on them.

## Keep namespaces flat

Option 4 has a lot of folders, and by default the IDE turns every folder into a namespace segment:

```csharp
namespace MyShop.Api.Orders.V1.Place.Endpoints;   // and you need five usings to get anything done
```

I set the namespace at the **version** level for everything below it:

```csharp
namespace MyShop.Api.Orders.V1;
```

In Rider and ReSharper, mark the folders below `V1` as "not a namespace provider" (folder properties,
or `.DotSettings` committed to the repository). In Visual Studio, the
`dotnet_style_namespace_match_folder` rule (IDE0130) can be configured per folder via `.editorconfig`.
All types of one version then see each other without `using` directives, and the folder structure
stays a pure navigation aid.

There's a side effect I like: because namespaces don't separate slices, type names must be
unambiguous on their own: `PlaceOrderRequest`, not `Request`. That makes search and stack traces much
clearer.

## Registration follows the folders

The structure only pays off if registration follows it too. Each level registers the level below,
and `Program.cs` knows nothing about individual endpoints:

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApi(builder.Configuration);

var app = builder.Build();
app.MapApi();
app.Run();

public partial class Program;   // for WebApplicationFactory<Program> in API tests
```

```csharp
// Api/Startup.cs
namespace MyShop.Api;

internal static class ApiStartup
{
    public static IServiceCollection AddApi(this IServiceCollection services, IConfiguration config) =>
        services.AddOrders(config)
                .AddCustomers(config);
}
```

```csharp
// Api/Orders/Startup.cs
namespace MyShop.Api.Orders;

internal static class OrdersStartup
{
    public static IServiceCollection AddOrders(this IServiceCollection services, IConfiguration config) =>
        services.AddOrdersV1(config);
        //      .AddOrdersV2(config);   // one line per version
}
```

```csharp
// Api/Orders/V1/Startup.cs
namespace MyShop.Api.Orders.V1;

internal static class OrdersV1Startup
{
    public static IServiceCollection AddOrdersV1(this IServiceCollection services, IConfiguration config) =>
        services.AddPlaceOrderEndpoint(config)
                .AddGetOrderByIdEndpoint()
                .AddSearchOrdersEndpoint()
                .AddCancelOrderEndpoint();
}
```

Disabling an endpoint is commenting out one line. Navigating from `Program.cs` to any endpoint is a
chain of F12 presses: API → domain → version → action. How the action itself registers and maps its
route is the topic of [*Anatomy of a minimal endpoint*](/blog/2026-anatomy-of-a-minimal-endpoint/).

## Pitfalls

**`_Shared_` becomes the new `Services` folder.** If half the logic ends up in `_Shared_`, you've
rebuilt option 2 with extra steps. Review it regularly: anything used by one action only moves back.

**Versioning by copy.** `V2` doesn't have to copy all of `V1`. A new version contains the actions
that changed. Unchanged actions stay in `V1` and are mapped into both version groups, or you
deliberately decide that `V2` is a complete new surface. Decide once, and document the decision
(see [*Lightweight ADRs*](/blog/2026-lightweight-adrs/)).

**Tests that don't mirror the structure.** If the API is `Api/Orders/V1/Place`, the tests should be in
`Api/Orders/V1/Place` too. Otherwise you lose the "everything in one place" benefit the moment you
look for a test.

**Over-structuring small services.** A service with three endpoints doesn't need four levels of
folders. The structure should grow with the API, not be imposed on day one.

## Make the structure checkable

A structure test is simple and catches the most common drift: an endpoint placed outside its
action folder, or a request type that ended up in `_Shared_`:

```csharp
[TestMethod]
public void Every_endpoint_lives_in_its_own_action_folder()
{
    var root = Path.Combine(SolutionDirectory, "src", "MyShop.Api", "Api");

    var misplaced = Directory.EnumerateFiles(root, "*Endpoint.cs", SearchOption.AllDirectories)
        .Where(file => Path.GetFileName(Path.GetDirectoryName(file)) is "_Shared_" or "V1" or "V2")
        .ToList();

    Assert.AreEqual(0, misplaced.Count, $"Endpoints outside an action folder: {string.Join(", ", misplaced)}");
}
```

It's crude, it's file-system based, and it works. Architecture rules don't have to be elegant to be
useful.

## Summary

- **By technology** is fine for demos and tiny APIs, and breaks as soon as the API grows.
- **Domain → technology** gives a good overview but still mixes actions inside a domain.
- **Feature + shared controller** is a good step on the way, but splits HTTP from the feature.
- **Feature + action** keeps everything for one endpoint in one folder. That's my default for new APIs.
- Keep **namespaces flat** at the version level, let **registration follow the folders**, and
  never mix two structures in one solution.
