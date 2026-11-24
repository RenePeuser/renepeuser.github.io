---
title: Creating NuGet packages your teams actually want to consume
date: 2026-11-23
authors: rene
tags: [dotnet, nuget, tooling]
excerpt: A package with no description, no readme, version 1.0.0 and a dependency on your analyzers is just a zip file with extra steps. What a good internal NuGet package needs, how to set up feeds and pipelines so nobody pushes by hand, and how to make the build refuse a half-finished package.
---


Sooner or later every organization with more than one .NET repository starts sharing code through NuGet
packages. A common library, an HTTP client for an internal API, a test SDK. That's a good move. What I
often see in internal feeds, though, are packages that never got their finishing touches: the
description says "Package Description", there's no readme, the version never changes, and installing it
drags a dozen build-time packages into your project.

A NuGet package is a product with users. It doesn't take much to treat it like one, and most of it is a
one-time setup in the repository.

## What consumers see

Open your feed in Visual Studio or Rider and look at your package from a consumer's point of view. They
see the ID, the description, the version list, the readme, the release notes and the dependencies. That's
all the information they get before deciding whether to install it, and whether an update is safe.

Here's a typical "before":

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Version>1.0.0</Version>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" />
  </ItemGroup>
</Project>
```

`dotnet pack` happily produces `MyShop.Common.1.0.0.nupkg` from it. Problems: the description is the SDK
default, the version is hand-written and will lie sooner or later, there's no license, no repository link,
no readme, and StyleCop becomes a transitive dependency for every consumer, so their builds start showing
your style warnings.

## The metadata that matters

Shared metadata belongs in [Directory.Build.props](/blog/2026-directory-build-props/), package-specific
metadata in the project:

```xml
<!-- Directory.Build.props -->
<PropertyGroup>
  <Authors>MyShop Platform Team</Authors>
  <Company>MyShop</Company>
  <Copyright>Copyright (c) MyShop</Copyright>
  <PackageLicenseExpression>MIT</PackageLicenseExpression>
  <PackageProjectUrl>https://github.com/myshop/common</PackageProjectUrl>
  <RepositoryUrl>https://github.com/myshop/common</RepositoryUrl>
  <PublishRepositoryUrl>true</PublishRepositoryUrl>
  <IsPackable>false</IsPackable> <!-- opt in per project, see below -->
</PropertyGroup>
```

```xml
<!-- src/MyShop.Common.Http/MyShop.Common.Http.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <IsPackable>true</IsPackable>
    <PackageId>MyShop.Common.Http</PackageId>
    <Description>Typed HTTP clients with standard resilience, correlation IDs and problem-details handling for MyShop services.</Description>
    <PackageTags>http;resilience;httpclient;myshop</PackageTags>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <PackageReleaseNotes>https://github.com/myshop/common/releases</PackageReleaseNotes>
  </PropertyGroup>

  <ItemGroup>
    <None Include="README.md" Pack="true" PackagePath="\" />
  </ItemGroup>
</Project>
```

A few decisions behind that:

- **`IsPackable=false` by default.** Only projects that are meant to be packages opt in. That stops test
  projects, samples and internal helpers from ending up in the feed when somebody runs `dotnet pack` on the
  solution.
- **License expression instead of a license file**, when the license is a standard SPDX one. It's
  machine-readable and tools can show it. For proprietary internal packages, `PackageLicenseFile` with your
  terms is fine.
- **A readme in the package.** It's rendered in the IDE and on the feed. Three short sections are enough:
  what it does, how to register it, one usage example.
- **Release notes as a link** to your releases or changelog. Inline release notes in the project file are
  always out of date.
- **No `Version`.** Versions come from git history with [GitVersion](/blog/2026-versioning-with-gitversion/).
  A package without meaningful versions is the single biggest reason consumers stop updating.

Add [Source Link](/blog/2026-source-link/) to that, so consumers can step into your code, and you have a
package people can work with.

## Dependencies: only what consumers really need

Everything in your project's `PackageReference` list becomes a dependency of your package, unless you say
otherwise. For build-time tools that's wrong:

```xml
<ItemGroup>
  <!-- analyzers, source link, versioning: needed to build the package, not to use it -->
  <PackageReference Include="Roslynator.Analyzers" PrivateAssets="all" />
  <PackageReference Include="GitVersion.MsBuild" PrivateAssets="all" />
</ItemGroup>
```

`PrivateAssets="all"` keeps them out of the `.nuspec`. With
[Central Package Management](/blog/2026-central-package-management/), `GlobalPackageReference` does this
automatically for everything you declare there.

For the dependencies that *do* flow to consumers, depend on the **lowest version you actually need**, not
the newest one that happens to be in your repository. A library that requires
`Microsoft.Extensions.Http 9.0.5` forces that version onto every consumer. If 8.0.0 works, depend on 8.0.0.

## Packages that belong together

If you ship several packages that are designed to be used together (say `MyShop.Common`,
`MyShop.Common.Client` and `MyShop.Common.Testing`), build them from **one repository, in one pipeline, with
one version**. A consumer should never have to figure out which version of the testing package matches
which version of the core package. Same number, done.

## Feeds and nuget.config

Every repository gets its own `nuget.config` next to the solution. That makes restores reproducible on every
machine and agent, independent of whatever someone configured globally:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="myshop" value="https://pkgs.example.com/myshop/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="myshop">
      <package pattern="MyShop.*" />
    </packageSource>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

The `<clear />` removes machine-level sources. **Package source mapping** guarantees that `MyShop.*` packages
only ever come from your feed, which protects you against dependency confusion: someone publishing a
package with your internal name on nuget.org.

Credentials never go into this file. Developers authenticate with their feed's credential provider, and
pipelines use the CI system's built-in authentication.

## Build and publish: only from the pipeline

I've seen wikis with step-by-step instructions for pushing packages by hand: get a temporary token, build in
Release, pack each project, make sure the three related packages match, push. Every one of those steps is a
chance to publish something that doesn't match any commit. Manual pushes are an emergency procedure at best.

A pipeline that packs every build and publishes from `main` and from tags:

```yaml
name: packages
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

jobs:
  pack:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-dotnet@v4
        with:
          global-json-file: global.json

      - run: dotnet build -c Release
      - run: dotnet test -c Release --no-build
      - run: dotnet pack -c Release --no-build -o artifacts

      - uses: actions/upload-artifact@v4
        with:
          name: packages
          path: artifacts/*.nupkg

      - name: Publish
        if: github.event_name == 'push'
        run: dotnet nuget push "artifacts/*.nupkg" --source myshop --api-key "${{ secrets.FEED_TOKEN }}" --skip-duplicate
```

Pull requests pack too (so packaging errors show up before merge) but don't publish. Pushes to `main`
publish pre-release versions, tags publish releases. With GitVersion, both get the right number
automatically. `--skip-duplicate` makes re-runs idempotent.

If you publish to nuget.org from GitHub Actions, use **trusted publishing** instead of a long-lived API key.
The workflow exchanges a short-lived token via OIDC, and there's no secret to leak or rotate.

## Ways to share code, compared

| | Project reference | Git submodule / shared source | NuGet package |
|---|---|---|---|
| Works across repositories | ❌ | ✅ | ✅ |
| Consumers choose when to update | ❌ | partly | ✅ |
| Versioned, with release notes | ❌ | ❌ | ✅ |
| Debuggable | ✅ | ✅ | ✅ with Source Link |
| Overhead | none | merge pain | pipeline + feed (one-time) |

Inside one repository, project references are the right choice. Across repositories, packages win, as long
as they're built properly.

## Pitfalls

**Pushing a version twice.** Feeds reject it, or worse, a cache somewhere already has the old content. A
published version is immutable. Fix forward with a new version.

**Debug builds in the feed.** Always pack `Release`. Source Link gives consumers a good debugging experience
without debug builds.

**Breaking changes in a minor version.** Consumers trust the number. Turn on
`EnablePackageValidation` with a baseline version so `dotnet pack` fails on accidental API breaks (details
in the [GitVersion post](/blog/2026-versioning-with-gitversion/)).

**Exposing third-party types in your public API.** If your public methods return types from another
package, that package's major version becomes part of your contract. Keep your public surface on your own
types and the BCL where you can.

## Make the build refuse a half-finished package

Guidelines for package metadata are forgotten as soon as somebody creates a new project. A small target in
`Directory.Build.targets` turns them into build errors:

```xml
<!-- Directory.Build.targets -->
<Project>
  <Target Name="EnsurePackageMetadata" BeforeTargets="GenerateNuspec" Condition="'$(IsPackable)' == 'true'">
    <Error Condition="'$(Description)' == '' or '$(Description)' == 'Package Description'"
           Text="$(MSBuildProjectName): set a meaningful <Description> for the package." />
    <Error Condition="'$(PackageReadmeFile)' == ''"
           Text="$(MSBuildProjectName): add a README.md and set <PackageReadmeFile>." />
    <Error Condition="'$(PackageLicenseExpression)' == '' and '$(PackageLicenseFile)' == ''"
           Text="$(MSBuildProjectName): set <PackageLicenseExpression> or <PackageLicenseFile>." />
  </Target>
</Project>
```

`Package Description` is the SDK default, which is exactly the value you want to catch. Add
`dotnet validate package local` after `dotnet pack` to check Source Link and deterministic builds as well,
and the pipeline guarantees that every package in your feed meets the bar.

## Summary

- A package is a product. Consumers decide based on **ID, description, readme, version and dependencies**.
- Put shared metadata in `Directory.Build.props`, make **`IsPackable` opt-in**, and ship a **readme** and a
  **license**.
- Never hand-write versions; derive them with **GitVersion**. Add **Source Link** for debugging.
- Keep build-time tools out of your dependencies with **`PrivateAssets="all"`**, and depend on the lowest
  versions you need.
- One **`nuget.config` per repository** with `<clear />` and **package source mapping**.
- **Publish only from the pipeline**; use trusted publishing for nuget.org.
- **Enforce** metadata with a target in `Directory.Build.targets` and validate packages after `pack`.
