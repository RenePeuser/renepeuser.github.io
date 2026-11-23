---
title: Slow Debug builds — it usually isn't Visual Studio
date: 2026-11-23
authors: rene
tags: [dotnet, tooling, performance]
excerpt: An incremental Debug build of six projects that takes 44 seconds isn't a hardware problem. How publish-time settings leak into the inner loop, why antivirus and Dev Drive matter, what Build Acceleration does, and how to get fast Debug builds without weakening a single quality gate.
---

:::note[Series]
Part of the series [*Code quality & tooling*](/series/code-quality-and-tooling/).
:::

If you've ever wanted to throw your laptop out of the window while Visual Studio shows "Build started..."
for the third time in five minutes, you're not alone. Slow builds are the most expensive problem nobody
puts on the backlog. They don't break anything. They just cost every developer a few minutes, dozens of
times a day, plus the focus that's gone by the time the build finishes.

In one solution I worked on, an **incremental Debug build of six projects, with no code changes, took
about 44 seconds**. The usual suspects were blamed: Visual Studio, the laptop, "the analyzers". The actual
fix took it to **about 5 seconds**, on the same machine and the same code, with every analyzer and every
CI quality gate still switched on. Here's what was going on, and what to check in your own solution.

## Symptom: the inner loop feels like a release pipeline

The signs are always similar:

- Visual Studio seems frozen during builds.
- Incremental builds take tens of seconds, even when nothing changed.
- CPU and disk spike on every build.
- Running a single test means waiting for the build first, every time.

When builds feel "mysteriously slow", the cause is almost always one of two things, often both: **the
machine is fighting the build** (antivirus), or **the project configuration turns a Debug build into
something much bigger than it needs to be**.

## Cause 1: antivirus and the file system

A build writes and reads thousands of small files in `bin/` and `obj/`, the NuGet cache and the SDK
folders. Real-time scanning of every one of them adds up quickly. In the solution above, adding exclusions
alone brought the build from about 44 to about 23 seconds. That's a lot, but it wasn't the main problem.

What helps:

- **Exclusions** for the source folders, the NuGet package cache (`%UserProfile%\.nuget\packages`) and the
  .NET SDK folder, agreed with whoever owns endpoint security in your organization.
- **A Dev Drive** on Windows 11. It's a ReFS volume designed for source code and package caches, and
  Microsoft Defender scans it in a performance mode that defers scanning instead of blocking every file
  operation. Moving the repositories and the NuGet cache (`NUGET_PACKAGES`) onto one is often the
  simplest exclusion you'll get approved.

## Cause 2: publish settings in the Debug build

This was the real culprit. Over time, the project files had picked up properties that belong to the
deployment, not to development:

```xml
<!-- MyShop.Orders.Api.csproj, before -->
<PropertyGroup>
  <TargetFramework>net9.0</TargetFramework>
  <RuntimeIdentifier>linux-x64</RuntimeIdentifier>
  <SelfContained>true</SelfContained>
  <PublishReadyToRun>true</PublishReadyToRun>
  <Nullable>enable</Nullable>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Each line made sense to someone at some point: the app runs on Linux, the serverless platform wanted a
self-contained package, [ReadyToRun](/blog/2026-publishing-readytorun/) improves cold starts. But because
they're **unconditional**, they apply to every F5 as well:

| Property | What it does | What it costs in Debug |
|---|---|---|
| `RuntimeIdentifier` | RID-specific restore, assets and output | slower restore and build, platform-specific output on a dev machine |
| `RuntimeIdentifiers` (lists) | resolves assets for several platforms | restore work multiplied per platform |
| `SelfContained` | ships the whole runtime with the app | copies the runtime into `bin` on every build |
| `PublishReadyToRun` | precompiles code at publish | extra restore work (crossgen package), no benefit while developing |
| `PublishSingleFile` / `PublishTrimmed` | bundle and trim the output | behaviour diverges from the source you're debugging |

Most `Publish*` properties only do their real work in `dotnet publish`. `RuntimeIdentifier` and
`SelfContained` don't wait for publish: they change restore and every single build. Put them together and
MSBuild runs something much closer to a publish pipeline than an incremental compile.

### A Linux RID on a Windows machine

`linux-x64` deserves a special mention, because it *looks* harmless: same CPU architecture, so what
could go wrong? But the operating system is different. The build produces a Linux app host that can't run
natively on Windows. At best, the launch profile routes execution through WSL or a container. At worst,
things fail in confusing ways. Symbols bind late, breakpoints are missed, and nobody connects it to one
line in the project file. `linux-arm64` at least fails obviously. `linux-x64` fails quietly.

## The fix: Debug is not Publish

The principle that solved it: **Debug builds are optimized for iteration speed. Publish builds are
optimized for the deployment target.** Trying to serve both with one unconditional configuration gives
you the worst of both.

The project file goes back to pure intent:

```xml
<!-- MyShop.Orders.Api.csproj, after -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <UserSecretsId>3f2c...</UserSecretsId>
  </PropertyGroup>
</Project>
```

The shared settings move to [Directory.Build.props](/blog/2026-directory-build-props/), and the
deployment settings move to where the deployment happens, the publish command in the pipeline:

```bash
dotnet publish src/MyShop.Orders.Api -c Release -r linux-x64 --self-contained \
  -p:PublishReadyToRun=true -o artifacts/api
```

If you really want them in a file, scope them so they can't leak into the inner loop. A publish profile
(`Properties/PublishProfiles/Linux.pubxml`) works, or a condition:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <RuntimeIdentifier>linux-x64</RuntimeIdentifier>
  <SelfContained>true</SelfContained>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

### What stays on in Debug

This is where I disagree with a lot of "speed up your build" advice: **I don't switch off analyzers,
`TreatWarningsAsErrors`, nullable errors, documentation generation or NuGet audit in Debug.** The gain
from that is small, and the cost is large: code that builds locally and fails in CI, which is the slowest
feedback loop of all. In the solution above, all of those stayed on, and the build still went from 23 to
5 seconds once the publish settings were gone. Consistent feedback between Debug and CI beats the last
few hundred milliseconds.

## Build Acceleration in Visual Studio

Once the configuration is clean, Visual Studio has one more trick. With **Build Acceleration**, VS checks
whether a changed project's dependents actually need to be recompiled. If a project's public API (its
reference assembly) didn't change, the projects that depend on it don't need to be recompiled, so VS just
copies the updated DLL instead of calling MSBuild for them.

```xml
<!-- Directory.Build.props -->
<PropertyGroup>
  <AccelerateBuildsInVisualStudio>true</AccelerateBuildsInVisualStudio>
</PropertyGroup>
```

Depending on your Visual Studio version it may already be on for SDK-style projects. Setting it explicitly
makes it unambiguous. When it works, the build output tells you so:

```
========== Build: 1 succeeded, 0 failed, 8 up-to-date, 0 skipped ==========
Visual Studio accelerated 6 project(s), copying 6 file(s). See https://aka.ms/vs-build-acceleration.
```

Two things to know: it helps **Build**, not **Rebuild**, and it relies on reference assemblies, which the
SDK produces by default. If a project disables `ProduceReferenceAssembly`, acceleration stops for its
dependents.

## Approaches compared

| | Faster Debug build | Same diagnostics as CI | Effort |
|---|---|---|---|
| Turn off analyzers / warnings-as-errors in Debug | some | ❌ | low |
| Antivirus exclusions / Dev Drive | ✅ | ✅ | low to medium (needs approval) |
| Move publish settings out of the inner loop | ✅✅ | ✅ | low |
| Build Acceleration | ✅ for incremental builds | ✅ | trivial |
| Solution filters (`.slnf`) for large solutions | ✅ fewer projects loaded and built | ✅ | low |
| Buying faster laptops | some | ✅ | expensive |

## Pitfalls

**Mixing `ProjectReference` and `PackageReference` for the same library.** If one project references
`MyShop.Common` as source and another as a NuGet package, MSBuild and NuGet fight over which one wins, and
you get conflicts, double copies and incremental builds that are never up to date. Pick one per solution.

**Copy-to-output for large files.** `CopyToOutputDirectory="Always"` forces a copy on every build and
defeats up-to-date checks. Use `PreserveNewest`.

**Custom targets without inputs and outputs.** A target that generates files on every build without
declaring `Inputs` and `Outputs` will run every time, and anything that depends on its output rebuilds too.

**Assuming Rebuild is the benchmark.** Developers live in incremental builds. Measure those.

## Measure, don't guess

Before you change anything, find out where the time actually goes. The **binary log** is the best tool for
that:

```bash
dotnet build -bl:debug.binlog
```

Open it in the [MSBuild Structured Log Viewer](https://msbuildlog.com/). Its timeline shows which projects
and targets take the time, whether `ResolvePackageAssets` or `_CopyFilesMarkedCopyLocal` dominate, and
which properties were actually set, including where they came from. A quicker overview without the viewer:

```bash
dotnet build -clp:PerformanceSummary
```

For a before/after comparison, use the scenario developers actually have: an **incremental build with no
changes** and one with a **single-line change** in a leaf project. Run each a few times and take the median.
Write the numbers into the pull request that fixes the configuration. It's the best argument against the
settings coming back.

To keep them from coming back, a small rule helps: fail the build (or a test) if a project file sets
`RuntimeIdentifier`, `SelfContained` or `PublishReadyToRun` unconditionally. The same kind of test as in
the [Directory.Build.props post](/blog/2026-directory-build-props/) works, just with a different list of
forbidden properties.

## Summary

- If Debug builds are slow, **inspect your project files before your hardware**.
- Antivirus scanning of `bin`/`obj` and package caches costs real time; use exclusions or a **Dev Drive**.
- The biggest killer is **publish settings in the inner loop**: `RuntimeIdentifier`, `SelfContained`,
  `PublishReadyToRun`, RID lists. Move them to the publish step or scope them to Release.
- A **Linux RID on Windows** silently turns debugging into emulation.
- Keep **quality gates on in Debug**. Same diagnostics locally and in CI matter more than milliseconds.
- Enable **Build Acceleration** and measure with a **binlog**, then guard the fix with a rule.
