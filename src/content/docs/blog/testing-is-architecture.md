---
title: Testing is architecture
date: 2026-11-23
authors: rene
tags: [testing, architecture, dotnet]
excerpt: Testability is one of the clearest indicators of architectural quality. If a system is hard to test, it is usually hard to understand, extend, or operate.
---

Testing reveals the shape of a system.

A design that is easy to exercise through stable public behavior is usually better separated and more
understandable than one that requires extensive internal knowledge to test.

## The layers I rely on

- **Unit tests** for focused rules
- **Contract tests** for public schemas and protocols
- **Integration tests** through real ASP.NET Core hosts
- **Snapshot tests** for broad regression detection
- **Architecture tests** for solution and dependency constraints
- **Generated samples** to verify documentation and contracts

## Frameworks should ship test affordances

A reusable platform should ship testing affordances alongside its runtime features. Product teams
should not have to reverse-engineer internal infrastructure merely to verify their endpoints.

That idea is exactly why I built
[AspNetCore.Simple.MsTest.Sdk](/projects/testing-sdk/). A test should communicate the scenario, the
input, the expected response and the expected protocol behavior — without pages of setup code:

```csharp
await Client.AssertPostAsync<CreateRequest>(
    "/api/v1/capabilities",
    "Requests/Create.json",
    "Responses/Create.json",
    expectedStatusCode: HttpStatusCode.Created);
```

:::tip[Rule of thumb]
If writing the test feels painful, don't blame the test — look at the design.
:::
