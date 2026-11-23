---
title: Central Package Management — one version per package, one place to change it
date: 2026-11-25
draft: true
authors: rene
tags: [dotnet, nuget, tooling]
excerpt: Forty projects, three versions of the same logging package and a downgrade warning nobody can explain. How Central Package Management with Directory.Packages.props fixes version drift, how to migrate, and which tools quietly break when you do.
---

:::note[Series]
Part of the series [*Code quality & tooling*](/series/code-quality-and-tooling/).
:::

Open any solution that has grown for a few years and search for one popular package across all
`.csproj` files. Chances are you'll find it in three different versions. One project was updated
when a bug was fixed, another one when a developer happened to click "Update all" in the NuGet UI,
and the rest were simply forgotten. Everything builds. Until the day it doesn't, and you get a
`NU1605` downgrade error from a project nobody touched.

**Central Package Management (CPM)** is the NuGet feature that ends this. In my opinion it's not an
optional nicety for medium and large solutions. It's basic infrastructure, in the same category as
a `Directory.Build.props` and a CI pipeline.

## The problem: versions live everywhere

Classic `PackageReference` mixes two things in one line: *that* a project uses a package, and
*which version* it uses.

```xml
<!-- MyShop.Orders.Api.csproj -->
<PackageReference Include="Serilog" Version="4.1.0" />

<!-- MyShop.Orders.Worker.csproj -->
<PackageReference Include="Serilog" Version="3.1.1" />

<!-- MyShop.Orders.Tests.csproj -->
<PackageReference Include="Serilog" Version="4.0.2" />
```

In a solution with a handful of projects you can keep that in sync by hand. With forty projects,
five teams and a dependency bot, you can't. What you get instead:

- **Version drift.** The same package in several versions, so the API and the worker behave
  differently at runtime, and nobody knows which version is "the" version.
- **Downgrade conflicts (`NU1605`).** Project A references 4.1.0, project B references A but pins
  3.1.1 directly. NuGet refuses to silently downgrade.
- **Builds that differ between machines and branches,** because a merge picked one version in one
  file and another version in a second file.
- **Expensive upgrades.** A security fix means touching dozens of files, and reviewing a diff that is
  mostly noise.

## What Central Package Management does

CPM separates the two concerns:

| Item | Where | Meaning |
|---|---|---|
| `PackageReference` | each `.csproj` | "This project uses package X." |
| `PackageVersion` | `Directory.Packages.props` | "In this repository, X is version Y." |

The versions move into a single file at the root of the repository. MSBuild discovers it
automatically, the same way it finds `Directory.Build.props`, and it applies to every project below
that folder.

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>

  <ItemGroup Label="Runtime">
    <PackageVersion Include="FluentValidation" Version="11.11.0" />
    <PackageVersion Include="Microsoft.Extensions.Http.Resilience" Version="9.0.0" />
    <PackageVersion Include="Serilog.AspNetCore" Version="9.0.0" />
  </ItemGroup>

  <ItemGroup Label="Tests">
    <PackageVersion Include="MSTest" Version="3.7.0" />
    <PackageVersion Include="NSubstitute" Version="5.3.0" />
  </ItemGroup>
</Project>
```

The project files shrink to what they should have been all along:

```xml
<!-- MyShop.Orders.Api.csproj -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="FluentValidation" />
    <PackageReference Include="Serilog.AspNetCore" />
  </ItemGroup>
</Project>
```

You can also put `ManagePackageVersionsCentrally` into `Directory.Build.props` next to your other
solution-wide settings. Both work. I prefer keeping it in `Directory.Packages.props`, because then
the file that holds the versions also declares that it's in charge.

CPM needs NuGet 6.2 or later, which means .NET SDK 6.0.300+, Visual Studio 2022 17.2+ or a current
Rider. Anything you're likely to run today qualifies. It works with every SDK-style project,
including those targeting .NET Framework. It doesn't work with `packages.config`.

## Migrating an existing solution

The migration is mechanical, which is good news, because it means you can do it in one pull request.

**1. Collect all versions in use.** `dotnet list package --format json` gives you every direct
reference per project. Pick one version per package. Usually that's the highest one in use, but
check the changelog for anything with a major version jump.

**2. Create `Directory.Packages.props`** with one `PackageVersion` per package, as above.

**3. Remove every `Version` attribute** from the `PackageReference` elements. If you forget one, the
build tells you: `NU1008` means "a version is specified in a project, but CPM is on".

**4. Restore and look at the graph.**

```bash
dotnet restore
dotnet list package --include-transitive
dotnet build
```

Fix what comes up: `NU1010` (a `PackageReference` without a matching `PackageVersion`), downgrade
warnings, and references that turn out to be unused. Those are suddenly very visible once all versions
sit in one list.

:::tip[Let the tooling write the file]
Recent .NET SDKs understand CPM: `dotnet add package Serilog` in a CPM-enabled repo adds a bare
`PackageReference` to the project and the `PackageVersion` to `Directory.Packages.props`. The Visual
Studio NuGet UI, Rider, Dependabot and Renovate handle it as well. Nobody needs to edit two files by
hand.
:::

## Transitive pinning: control what you don't reference

Without further configuration, CPM only governs **direct** references. If `MyShop.Orders.Api` gets an
old, vulnerable `System.Text.Json` through some third-party package, a `PackageVersion` entry for
`System.Text.Json` does nothing, because no project references it directly.

`CentralPackageTransitivePinningEnabled` changes that. With it, a `PackageVersion` also acts as a
minimum for transitive dependencies. Add the entry, and every project that pulls in the package
indirectly gets your version instead.

That's the clean way to fix a vulnerable transitive dependency (more on that in the post about
[NuGet audit](/blog/2026-nuget-audit-and-transitive-dependencies/)). Use it with care, though: you're
now overriding what a library author tested against. Add a comment next to each pin explaining why it
exists, so someone can remove it once the upstream package catches up.

```xml
<!-- Pinned: transitive via LegacyPdfLib 2.x, which still depends on a vulnerable version. -->
<PackageVersion Include="System.Text.Json" Version="9.0.0" />
```

## Escape hatches (and why you should rarely need them)

Two features exist for exceptions:

```xml
<!-- In a single .csproj: use a different version than the central one -->
<PackageReference Include="Serilog.AspNetCore" VersionOverride="8.0.3" />
```

```xml
<!-- In Directory.Packages.props: added to every project, no PackageReference needed -->
<ItemGroup>
  <GlobalPackageReference Include="Roslynator.Analyzers" Version="4.12.9" />
</ItemGroup>
```

`GlobalPackageReference` is great for analyzers and build-only packages (Roslynator, Source Link,
`Nerdbank.GitVersioning` and the like), because they belong to every project and have no runtime
footprint.

`VersionOverride` is the one I'd treat as a code smell. "Different versions per project" is exactly
the drift CPM was introduced to stop. If you really need it temporarily, for instance while one project
waits for a breaking upgrade, make it visible and time-boxed. You can even turn it off completely with
`<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>`.

## Things that break when you switch

The build is the easy part. What bit the teams I've seen migrate was **everything around the build**
that had assumptions about project files baked in:

| Tool | Old assumption | What it must do now |
|---|---|---|
| Custom solution/project parsers | The version is an attribute of `PackageReference` | Resolve `PackageVersion` items from `Directory.Packages.props` (and imports) |
| Analyzers / code rules about packages | Version is in the `.csproj` | Inspect `PackageVersion`; never assume `Version` exists on a reference |
| Upgrade scripts, version reports | Edit or read each `.csproj` | Edit or read one central file |
| CI pipelines | Any SDK will do | NuGet ≥ 6.2 / SDK ≥ 6.0.300 on every agent |

If you have internal tooling that reads project files with `XDocument` instead of MSBuild, budget time
for it. The cleanest fix is to stop parsing XML yourself and ask MSBuild for the evaluated items, e.g.
with `dotnet msbuild -getItem:PackageReference` or the `Microsoft.Build` APIs. Then CPM, imports and
conditions are all handled for you.

## Pitfalls

**Nested `Directory.Packages.props` files.** MSBuild only picks up the *nearest* one, walking up from
the project. A second file in a subfolder replaces the root file instead of extending it. If you want
inheritance, import the parent explicitly:

```xml
<Import Project="$([MSBuild]::GetPathOfFileAbove(Directory.Packages.props, $(MSBuildThisFileDirectory)..))" />
```

**Multiple package sources.** With CPM enabled, NuGet warns with `NU1507` when you have more than one
source and no [package source mapping](https://learn.microsoft.com/nuget/consume-packages/package-source-mapping).
Don't suppress it. Configure the mapping in `nuget.config`. It's also your protection against dependency
confusion attacks.

**`NU1605` hidden by your own settings.** The .NET SDK already treats `NU1605` as an error by default.
If your `Directory.Build.props` sets `WarningsAsErrors` to a custom list, make sure you *append* to the
existing value (`$(WarningsAsErrors);NU1605`) instead of replacing it.

**Pinning everything transitively "just in case".** Every pin is a version you now own. Pin to fix a
concrete problem, not as a reflex.

## Enforce it

A convention like "never put versions in project files" survives exactly until the first developer who
doesn't know about it. Make the build check it. `NU1008` already covers version attributes once CPM is
on. What it can't cover is "CPM must stay on" and "no `VersionOverride`". A small test does:

```csharp
[TestClass]
public sealed class PackageManagementRules
{
    private static readonly DirectoryInfo Root = FindRepositoryRoot();

    [TestMethod]
    public void Repository_uses_central_package_management()
    {
        var props = new FileInfo(Path.Combine(Root.FullName, "Directory.Packages.props"));

        Assert.IsTrue(props.Exists, "Add a Directory.Packages.props at the repository root.");

        var enabled = XDocument.Load(props.FullName)
            .Descendants("ManagePackageVersionsCentrally")
            .Any(e => string.Equals(e.Value.Trim(), "true", StringComparison.OrdinalIgnoreCase));

        Assert.IsTrue(enabled, "Set <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>.");
    }

    [TestMethod]
    public void Projects_do_not_override_central_versions()
    {
        var offenders = Root.EnumerateFiles("*.csproj", SearchOption.AllDirectories)
            .SelectMany(p => XDocument.Load(p.FullName)
                .Descendants("PackageReference")
                .Where(r => r.Attribute("Version") is not null || r.Attribute("VersionOverride") is not null)
                .Select(r => $"{p.Name}: {r.Attribute("Include")?.Value}"))
            .ToList();

        Assert.AreEqual(0, offenders.Count,
            $"Move these versions to Directory.Packages.props: {string.Join(", ", offenders)}");
    }

    private static DirectoryInfo FindRepositoryRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        return dir ?? throw new InvalidOperationException("Repository root not found.");
    }
}
```

It runs with the normal test suite, locally and in CI, and the failure message says exactly what to
do. That's the idea behind [self-defending codebases](/blog/2026-self-defending-codebases/): the rule
lives in the repository, not in a wiki page.

Last but not least: make `Directory.Packages.props` an owned file. A `CODEOWNERS` entry means version
changes get reviewed by someone who looks at the whole picture, and the review is easy, because the
diff is now one line per package instead of one line per project.

## Summary

- Classic `PackageReference` mixes *usage* and *version*; in larger solutions that leads to drift,
  `NU1605` downgrades and painful upgrades.
- **CPM** moves all versions into `Directory.Packages.props`. Projects only say what they use.
- Migration is mechanical: collect versions, create the central file, strip `Version` attributes,
  restore and fix the warnings.
- Use **transitive pinning** deliberately to fix vulnerable indirect dependencies, with a comment per
  pin. Use **`GlobalPackageReference`** for analyzers. Treat **`VersionOverride`** as a smell.
- Plan for the tooling around the build: parsers, scripts and analyzers that read `.csproj` files.
- **Enforce** it with a test or analyzer and give the central file an owner.
