---
title: Publishing ReadyToRun — faster startup without touching a line of code
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, performance, devops, tooling]
excerpt: Cold starts in serverless functions, slow first requests after every deployment, containers that take ages to become healthy. ReadyToRun precompiles your code at publish time. What it actually does, when it helps, how it compares to Native AOT, and how to measure whether it's worth it for you.
---

:::note[Series]
Part of the series [*Code quality & tooling*](/series/code-quality-and-tooling/).
:::

Every .NET application pays a startup tax: before a method runs for the first time, the JIT compiler has
to turn its IL into machine code. For a long-running web API that's a one-off cost nobody notices. For a
serverless function that's started on demand, a CLI tool that runs for two seconds, or a container that
has to pass its health check before the orchestrator gives up, it can be most of the time the user waits.

**ReadyToRun (R2R)** moves a large part of that work from startup to publish time. It's one property,
it needs no code changes, and in the codebases where startup mattered I recommended turning it on as
the first step, long before anyone talked about Native AOT.

## Where the startup time goes

A typical ASP.NET Core app touches thousands of methods before it can answer the first request:
configuration binding, dependency injection, routing, serialization, logging, your own startup code. Each
of them is JIT-compiled the first time it's called.

```mermaid
flowchart LR
    A[Process start] --> B[Load assemblies]
    B --> C["JIT: compile each method<br/>on first call"]
    C --> D[Run startup code]
    D --> E[First request served]
    style C fill:#f9d6d5,stroke:#c0392b
```

The .NET runtime already reduces the pain with **tiered compilation**: methods are first compiled
quickly with few optimizations (tier 0), and only hot methods are recompiled with full optimizations
later (tier 1). The shared framework itself ships precompiled. But your own assemblies and every NuGet
package you reference are IL only, and they all go through the JIT on first use.

## What ReadyToRun does

When you publish with ReadyToRun, the SDK runs the **crossgen2** compiler over your assemblies and stores
native code for a specific platform next to the IL, in the same file. At runtime, the loader uses that
precompiled code instead of calling the JIT.

The IL stays in the assembly. That matters for three reasons:

- If the precompiled code can't be used (a different CPU architecture, a version mismatch with a
  dependency), the runtime falls back to the JIT. Nothing breaks.
- Tiered compilation still works. R2R code acts roughly like tier 0, and hot methods get recompiled with
  full optimizations, including dynamic PGO. So steady-state throughput is the same as without R2R.
- Reflection, dynamic loading and everything else that works with JIT keeps working. There are no
  trimming or AOT compatibility rules to follow.

You pay for it with **larger assemblies** (they contain IL *and* native code) and a **platform-specific
publish**.

## How to enable it

Either in the project file:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <RuntimeIdentifier>linux-x64</RuntimeIdentifier>
</PropertyGroup>
```

or, which I prefer, only in the pipeline's publish step:

```bash
dotnet publish src/MyShop.Orders.Api -c Release -r linux-x64 -p:PublishReadyToRun=true -o artifacts/api
```

A runtime identifier is required, because native code is per platform. Keeping it on the command line
has an advantage: local `dotnet build` and `dotnet run` stay fast and platform-neutral, and only the
artifact that actually gets deployed is precompiled.

Cross-compiling works. You can publish `linux-x64` or `linux-arm64` on a Windows agent. The SDK downloads
the matching crossgen2 package during restore.

### Self-contained and composite

For self-contained deployments there's one more step: compile the framework and your app together into
a single **composite** image.

```bash
dotnet publish src/MyShop.Orders.Api -c Release -r linux-x64 --self-contained \
  -p:PublishReadyToRun=true -p:PublishReadyToRunComposite=true
```

Composite R2R lets the compiler optimize across assembly boundaries, which gives the best startup R2R can
offer. It also gives you the largest output, and it only makes sense if you ship the runtime with your app
anyway.

## ReadyToRun vs. the alternatives

| | JIT only (default) | ReadyToRun | R2R composite (self-contained) | Native AOT |
|---|---|---|---|---|
| Startup time | baseline | better | best of the R2R options | best |
| Steady-state throughput | ✅ full (tiered + PGO) | ✅ full (tiered + PGO) | ✅ full | good, no dynamic PGO |
| Output size | smallest | larger | largest | small single binary, no runtime needed |
| Code changes needed | none | none | none | often: no unbounded reflection, trimming-safe libraries |
| Library compatibility | everything | everything | everything | only AOT-compatible libraries |
| Platform-specific publish | ❌ | ✅ | ✅ | ✅ |

**Native AOT** is the bigger hammer: no JIT at all, tiny startup, low memory. But it requires that your
code and every dependency are trimming- and AOT-compatible. For a minimal API with `System.Text.Json`
source generation that's realistic. For a typical line-of-business service with a full ORM, a mapper
and some reflection-heavy libraries, it's often a project of its own. ReadyToRun is the option you can
turn on this afternoon.

## When it's worth it

**Clear wins:**

- Serverless functions (AWS Lambda, Azure Functions), where cold starts are directly visible in response
  times.
- CLI tools and short-lived jobs, where startup *is* most of the runtime.
- Containers that are scaled out under load, where a new instance should take traffic as fast as possible.
- Desktop applications, where the first window should appear quickly.

**Marginal:**

- Long-running services that start once a week. The JIT cost is paid once and then forgotten. R2R doesn't
  hurt, but the larger image is the only visible change.

## Pitfalls

**Turning off tiered compilation "for performance".** With `TieredCompilation=false`, R2R code is never
replaced by optimized code, so hot paths stay at R2R quality forever. Leave tiered compilation at its
default. If you see old pipeline snippets that set it explicitly, check why.

**Publish behaves differently from build.** `dotnet publish -r linux-x64` performs a RID-specific restore:
it pulls in runtime packs and the crossgen2 package, and it can resolve a slightly different dependency
graph than `dotnet build`. Problems that only appear in the publish step, such as NuGet audit warnings
turning into errors, are often caused by exactly this. I describe one of those cases in the post about
[NuGet audit](/blog/2026-nuget-audit-and-transitive-dependencies/). Run the same publish command in your
PR build, not only in the release pipeline.

**Expecting it to fix slow startup code.** R2R removes JIT time. If your app spends five seconds at
startup warming a cache or running migrations, R2R won't change that. Measure first (see below).

**RID mismatches.** An image compiled for `linux-x64` running on an ARM host will fall back to the JIT,
silently. It still works, it just isn't faster. Publish for the architecture you actually run on.

**Debugging precompiled code.** Debugging works, but the debugger may show optimized code for methods that
came from the R2R image. If you need to step through a deployed build, the
[Source Link post](/blog/2026-source-link/) covers the "suppress JIT optimization" setting, and you can
disable the use of precompiled code with an environment variable (below).

## Measure it

Don't take startup improvements on faith. Measure them for your app.

**Count JIT-compiled methods.** `dotnet-counters` shows how many methods the JIT compiled. With R2R, that
number at startup should drop dramatically:

```bash
dotnet-counters monitor --process-id <pid> --counters System.Runtime
# look at the JIT-compiled methods counter during and right after startup
```

**A/B test with one switch.** You don't need two builds to compare. The runtime can ignore precompiled
code:

```bash
DOTNET_ReadyToRun=0 ./MyShop.Orders.Api   # behaves as if R2R was off
./MyShop.Orders.Api                       # uses the R2R code
```

Measure the time from process start to the first successful health check or response, a few times each,
on the target hardware. A small script that starts the app and polls `/health` in a loop gives you a
number that's directly relevant to your deployment.

**In production,** watch cold start durations (most serverless platforms report them) or the time new
container instances need to become ready. That's the number your users actually feel.

## Summary

- Every method is JIT-compiled on first call, and that dominates startup for serverless functions, CLI
  tools and freshly scaled containers.
- **ReadyToRun** precompiles your code and dependencies at publish time. The IL stays, so tiered
  compilation, PGO and reflection keep working.
- Enable it with **`-p:PublishReadyToRun=true -r <rid>`** in the publish step. Use **composite** for
  self-contained apps.
- It costs **larger output** and a **platform-specific** publish. **Native AOT** starts even faster but
  needs compatible code and libraries.
- Keep tiered compilation on, publish for the right architecture, and run the RID-specific publish in PR
  builds too.
- **Measure** with JIT counters and `DOTNET_ReadyToRun=0` instead of guessing.
