---
title: Testing the solution itself — architecture tests and .NET global tools
date: 2019-12-23
authors: rene
tags: [retrospective, architecture, testing, dotnet]
excerpt: Unit tests check what code does. But who checks the solution — project references, conventions, attributes? From a 2016 .sln parser to Roslyn-based rule tests and a set of .NET global tools, this is how I started testing the codebase as a whole.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2019. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

Large solutions break in ways unit tests don't catch. A project references something it shouldn't.
A test project ends up with a different target framework. An assembly is copied locally when it
shouldn't be. Somebody forgets an attribute that every class in a folder is meant to have. Code
reviews catch some of these. Wiki pages with conventions catch none.

My answer, which took several years to take shape, was to treat the solution itself as something
you can test. You parse it, query it, and fail the build when a convention is broken. By the end of
2019 that idea came together with a second one: package the tooling as .NET global tools, and keep
the code behind them testable by abstracting the file system and processes.

## 2016: parsing .sln and .csproj

The first attempt was
[SolutionAndProjects](https://github.com/RenePeuser/SolutionAndProjects), started in September 2016.
Its README says: *extract information from a solution and its projects for testing.* The solution
file is read with MSBuild's own parser. Projects get split into production and test projects by
their project-type GUIDs:

```csharp
public static SolutionFile Parse(SolutionFileInfo solutionFileInfo)
{
    var solutionFile = Microsoft.Build.Construction.SolutionFile.Parse(solutionFileInfo.Value.FullName);

    var projects = solutionFile.ProjectsInOrder
        .Where(item => Path.GetExtension(item.RelativePath) == ".csproj")
        .Select(item => new ProjectFileInfo(item.AbsolutePath))
        .Select(ProjectFileParser.Parse)
        .ToList();

    var unitTestProjects = projects.Where(p => p.ProjectTypes.Any(t => t == ProjectType.Test)).ToList();
    var productiveProjects = projects.Except(unitTestProjects);

    return new SolutionFile(solutionFileInfo, projects, productiveProjects, unitTestProjects);
}
```

Each `.csproj` (still the old, verbose format) is loaded as an `XDocument`. It's turned into a typed
model: assembly references with `HintPath` and `CopyLocal`, project references, imports, C# and
XAML files, content items and the target framework version. On top of that sit generic check
helpers that take a predicate and an error-message factory:

```csharp
public static IEnumerable<ProjectFileErrorResult> CheckAssemblyReferencesForErrors(
    this IEnumerable<ProjectFile> projects,
    Func<AssemblyReference, bool> findErrorFunc,
    Func<AssemblyReference, string> errorValue)
```

A rule is then a lambda pair and an assert. Here's a sketch with the 2016 API:

```csharp
var errors = solution.ProductiveProjects.CheckAssemblyReferencesForErrors(
    reference => reference.CopyLocal,
    reference => $"'{reference.Include}' must not be copied locally");

Assert.IsFalse(errors.Any(), string.Join(Environment.NewLine, errors.Select(e => e.ErrorMessage)));
```

Each `ProjectFileErrorResult` formats its own message: the project name, then one line per
violation. That detail mattered more than I expected. A rule test is only useful if the failure
message tells you exactly what to fix.

:::note
I also tried Microsoft Pex/IntelliTest on the analyzer in that repository. The generated stubs are
still there, with their `TODO: add assertions`. The tool was interesting, but rule tests written by
hand turned out to be far more useful.
:::

## Rules on source code: the DebuggerHidden test

Project files are one layer. Source code is the next. When I started
[Argument.Check](https://github.com/RenePeuser/Argument.Check) in December 2019, I wanted every
method in the library marked `[DebuggerHidden]`. That way the debugger stops at the caller's bad
argument, not inside the guard helper. Instead of trusting myself to remember, I wrote a test that
parses all source files with Roslyn and queries them with LINQ:

```csharp
[TestMethod]
public void All_Methods_Must_Be_Decorated_With_The_DebuggerHidden_Attribute()
{
    var missingHiddenAttribute =
        from file in cSharpFileInfos
        from @class in file.SyntaxTree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>()
        from method in @class.DescendantNodes().OfType<MethodDeclarationSyntax>()
        let attributeLists = method.AttributeLists
        where !attributeLists.Any()
              || !attributeLists.First().Attributes.Any(a => a.Name.ToString().Contains("DebuggerHidden"))
        select new AnalyzeResult(file.FileInfo, method.Identifier.ToString());

    Assert.IsFalse(missingHiddenAttribute.Any(), ToMessage(missingHiddenAttribute));
}
```

The same test appears again in `FileSystem.Abstraction` and `DotNetTool.Service`, aimed at their
argument-check folders. It's crude. Matching on attribute names as strings is not semantic analysis.
But it runs with every test run, so the convention can't quietly wear away.

## Packaging tools as dotnet global tools

At the same time, .NET Core 3 made global tools practical: a console app with
`<PackAsTool>true</PackAsTool>` becomes a NuGet package you install with `dotnet tool install -g`.
I wanted to write small CLIs often, and the `System.CommandLine` wiring was the same every time. So
the first tool I built, in December 2019, was a tool that builds tools:
[DotNetTool.Builder](https://github.com/RenePeuser/DotNetToolBuilder).

```xml
<PropertyGroup>
  <OutputType>Exe</OutputType>
  <TargetFramework>netcoreapp3.0</TargetFramework>
  <PackAsTool>true</PackAsTool>
  <ToolCommandName>dotnet-newtool</ToolCommandName>
</PropertyGroup>
```

Because the command name starts with `dotnet-`, it runs as `dotnet newtool`, as if it were part of
the SDK. You describe your CLI as expressions such as
`root sub1 <sub1Arg>[System.IO.FileInfo] --sub1-opt <sub-opt-value>`. The builder tokenizes and
validates them, then generates commands, options, handlers and one service class per command, which
is where your own logic goes. The tokenizer and validator were the first things under test: one test
class per expression shape, plus a list of valid and invalid expressions that all have to pass.

## Abstractions that make tooling testable

Tooling code is mostly side effects: reading files, creating directories, starting `dotnet`. If you
call `System.IO` and `Process.Start` directly, that's hard to test. In the first days of 2020 I split
two small libraries out of this work.

[DotNetTool.Service](https://github.com/RenePeuser/DotNetTool.Service) wraps `dotnet tool` commands
as a service. Each command depends on a narrow process interface, not on `Process` itself:

```csharp
internal interface IProcessService
{
    Task<CliRunResult> RunCliCommandAsync(string command, string arguments);
}

internal sealed class InstallCommand
{
    private readonly IProcessService _processService;

    internal Task<CliRunResult> InstallAsync(string toolName, string version)
    {
        Throw.IfNullOrWhiteSpace(() => toolName);
        Throw.IfNullOrWhiteSpace(() => version);

        return _processService.RunCliCommandAsync("dotnet", $"tool install {toolName} --version {version} --global");
    }
}
```

That seam is what makes the commands substitutable: a unit test can replace `IProcessService` and
assert the exact command line. The repository itself went the other way first. Its system tests
really install, update and uninstall a tool, and the tool they use is DotNetTool.Builder. One of my
tools tests the other.

[FileSystem.Abstraction](https://github.com/RenePeuser/FileSystem.Abstraction) does the same for
`FileInfo` and `DirectoryInfo`. An `IFileService` hands out `IFileInfo` objects, which also carry the
handy `File.ReadAllLines`/`WriteAllText` methods. You can register them in any DI container:

```csharp
services.AddSingleton<IFileService, FileService>();
services.AddSingleton<IDirectoryService, DirectoryService>();
```

:::tip[Why not one big abstraction?]
Each interface covers only what the tools actually needed. Small interfaces are easy to substitute,
and they make a class's dependencies honest. A constructor that takes an `IProcessService` tells you
right away that it shells out.
:::

## Where it led

The parsing work kept growing. In 2021 came
[CSharp.Parser.Abstraction](https://github.com/RenePeuser/CSharp.Parser.Abstraction), a friendlier
model over Roslyn syntax trees. From 2022 on, everything merged into
[Solution.Parser](https://github.com/RenePeuser/Solution.Parser), which reads solutions (`.sln` and
`.slnx`), SDK-style projects, C# and XAML into a LINQ-friendly model. It also checks its own package
layering with exactly the kind of test that started in 2016:

```csharp
[TestMethod]
public void Core_Depends_On_Nothing_Of_Its_Own()
{
    Assert.That.HasCount(0,
                         ProjectReferencesOf("Solution.Parser.Core"),
                         because: "Core is the bottom of the stack, everything else builds on it",
                         fix: LayeringFix);
}
```

As of July 2026, my [NuGet profile](https://www.nuget.org/profiles/Rene.Peuser) lists roughly 443K
downloads for [Solution.Parser](https://www.nuget.org/packages/Solution.Parser/), 300K for
[FileSystem.Abstraction](https://www.nuget.org/packages/FileSystem.Abstraction/), 165K for
[DotNetTool.Service](https://www.nuget.org/packages/DotNetTool.Service/) and 122K for
[DotNetTool.Builder](https://www.nuget.org/packages/DotNetTool.Builder/).

## Lessons that stuck

- **Conventions you don't test are suggestions.** If a rule matters, write it as a query plus an
  assertion, and let the build enforce it.
- **The failure message is the product.** List every violation with its file and the fix. A rule
  that only says "false" gets disabled.
- **Abstract side effects at the edges, and keep the interfaces narrow.** It made the global tools
  testable without a real file system or a real `dotnet` process.

What I'd do today: use semantic models instead of string matching where it matters, keep the rules
as plain unit tests (no separate tool for developers to learn), and reach for the
`System.IO.Abstractions` ecosystem or the new `TimeProvider`-style abstractions before writing my
own, unless I need exactly the narrow shape my tools ask for.
