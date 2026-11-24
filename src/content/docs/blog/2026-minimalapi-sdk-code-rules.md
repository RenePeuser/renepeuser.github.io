---
title: 109 rules as plain unit tests — keeping a minimal API codebase consistent
date: 2026-11-24
draft: true
authors: rene
tags: [aspnetcore, minimal-api, architecture-tests, code-quality, open-source]
excerpt: A blueprint only helps while people follow it. AspNetCore.MinimalApi.Sdk ships with a CodeRules project, 109 rules written as MSTest tests over the parsed solution, each failure with the file, the offending syntax and a corrected sample. I ran them against the blueprint itself for this post. 112 test cases passed, 20 failed, and the failures teach more than the passes.
---

:::note[Series]
Part three of the series [*AspNetCore.MinimalApi.Sdk*](/series/aspnetcore-minimalapi-sdk/). Code:
[github.com/RenePeuser/AspNetCore.MinimalApi.Sdk](https://github.com/RenePeuser/AspNetCore.MinimalApi.Sdk).
:::

[Part one](/blog/2026-minimalapi-sdk-a-blueprint-for-minimal-apis/) described a structure for
minimal APIs. [Part two](/blog/2026-minimalapi-sdk-typed-client-and-cli/) showed that a generated
client and CLI are only as good as the endpoint metadata. Both parts end with the same problem:
**conventions erode**. A missing `WithName` is invisible in code review, until the generated client
has a method called `Get2`. A `Produces(200, typeof(Todo))` on an endpoint that returns a list compiles
fine and breaks every consumer.

The blueprint's answer is a test project called `AspNetCore.MinimalApi.Sdk.CodeRules`. It contains
**109 rules**, written as ordinary MSTest tests, that parse the whole solution and check it against
the conventions. They run with `dotnet test`, locally and in CI, like every other test.

## The "before": conventions in a wiki

Most teams have a page like this somewhere:

> - Every endpoint must have an operation ID (`WithName`).
> - Every endpoint must document 200, 400 and 500.
> - No endpoint mappings in `Program.cs`.
> - Versions go into namespaces, not class names.
> - Every service registers itself.

The page is correct and nobody reads it twice. New team members learn the rules from review comments,
one rejected pull request at a time. AI coding agents never read it at all. The
[self-defending codebases post](/blog/2026-self-defending-codebases/) is about the general idea:
turn that page into checks that run. This post is the concrete version for minimal APIs.

## What's in the box

The rules are grouped by folder and by `TestCategory`. I counted them in the repository:

| Area | Rules | Examples |
|---|---:|---|
| Minimal API (`RJIT_CR_MAPI_*`) | 18 | `MapToApiVersion`, `WithName` containing the version, `WithTags`, `Produces(2xx/400/5xx)`, no mappings in `Program.cs`, version in namespace matches mapped version, `public partial class Program` for API tests |
| Controllers (`RJIT_CR_API_C_*`) | 29 | for solutions that still have controllers: one HTTP attribute per method, `ApiVersion` attribute, lowercase routes |
| Async/await (`RJIT_CR_AA_*`) | 24 | `Async` suffix, no `Task.WaitAll`, no nested `Task<Task>`, `IAsyncEnumerable` instead of `IEnumerable<Task>` |
| Mediator (`RJIT_CR_MR_*`) | 10 | request and response are records, handlers internal, request in the same file as its handler |
| Records, classes, structs, interfaces, enums | 21 | immutable properties, no versions in type names, no partial types, no reserved keywords as names |
| Services (`RJIT_CR_S_*`) | 5 | registration extension in the same file, dependencies registered too, registration actually called, `IEnumerable<T>` for injected sets |
| Projects (`RJIT_CR_CSPROJ_*`) | 2 | mandatory build settings, no test packages in production projects |

With data-driven rows, the 109 rules expand to **132 test cases**.

## How a rule works

All rules derive from a `MsTestBase` that parses the solution once per test run with my
[Solution.Parser](https://github.com/RenePeuser/Solution.Parser) and exposes the result as static,
immutable lists:

```csharp
[AssemblyInitialize]
public static void Init(TestContext _)
{
    var solutionFileInfo = new SolutionFileName("AspNetCore.MinimalApi.Sdk.sln")
        .FindSolutionFileReverseFrom(new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory));
    Throw.IfNull(solutionFileInfo);

    Solution = solutionFileInfo.Parse();

    ProductiveSyntaxTrees = Solution.ProductiveProjects.SelectMany(p => p.CSharpFileInfos)
                                                        .Select(c => c.Parse())
                                                        .ToImmutableList();

    TestSyntaxTrees = Solution.UnitTestProjects.SelectMany(p => p.CSharpFileInfos)
                                               .Select(c => c.Parse())
                                               .ToImmutableList();

    AllSyntaxTrees = ProductiveSyntaxTrees.Concat(TestSyntaxTrees).ToImmutableList();

    Records = AllSyntaxTrees.SelectMany(tree => tree.Records).ToImmutableList();
    Classes = AllSyntaxTrees.SelectMany(tree => tree.Classes).ToImmutableList();
    Enums = AllSyntaxTrees.SelectMany(tree => tree.Enums).ToImmutableList();
    Interfaces = AllSyntaxTrees.SelectMany(tree => tree.Interfaces).ToImmutableList();
    Structs = AllSyntaxTrees.SelectMany(tree => tree.Structs).ToImmutableList();

    // ... plus *.sql files and SQL string literals found via Roslyn
}
```

(Trimmed: the original also filters out an ignore list of namespaces.) Productive and test code are
kept apart, so a rule can decide which one it looks at.

A rule is then a LINQ query over those lists and one assertion. This is the rule that requires
every endpoint mapping to declare its version, as it is in the repository except for the separator
lines in the message:

```csharp
[TestCategory("Coding-Rules")]
[TestCategory("API - Minimal API")]
[TestClass]
public class RJIT_CR_MAPI_00002 : MinimalApiTestBase
{
    [TestMethod]
    public void Each_Minimal_Api_Mapping_Must_Use_MapToApiVersion_Extension()
    {
        var invalidEndpointMappings = (from mapStatement in MapStatements
                                       where mapStatement.SyntaxTree.DoesNotContain(".MapToApiVersion")
                                       select new
                                       {
                                           Error = $@"
FilePath:  {mapStatement.FilePath}
Syntax:

{mapStatement.SyntaxTree.FormatSyntaxTree()}
Sample:

{mapStatement.SyntaxTree.Replace("});", "}).MapToApiVersion(1);").FormatSyntaxTree()}
"
                                       }).ToImmutableList();

        Assert.IsTrue(invalidEndpointMappings.IsEmpty(),
            @$"
Documentation: {DocumentationDomain}#RJIT_CR_MAPI_00002

Please explicit declare the api version mapping, in which version this endpoint should be available.
Dont forget to provide a versio set, managed by .MapGroups to bundle version base information and more.

Findings {invalidEndpointMappings.Count}':

{invalidEndpointMappings.Select(error => error.Error).Flatten(Environment.NewLine)}{Environment.NewLine}");
    }
}
```

Three design choices matter more than the query itself:

1. **A stable ID per rule** (`RJIT_CR_MAPI_00002`), used as the class name and as a documentation
   anchor. You can search for it, link to it, and discuss "MAPI 2" in a review.
2. **The failure message is the documentation.** It says *what* is wrong, *why* the rule exists,
   *where* (file path and the offending statement) and *how to fix it*.
3. **A corrected sample.** The `Sample:` block is the offending code with the fix already applied.
   A developer copies it. An AI agent reads it and does the same. That's the step from "the linter
   is annoying" to "the codebase tells me what it wants".

Rules aren't limited to C#. The project-file rule is data-driven over required MSBuild settings:

```csharp
[DataRow("LangVersion", "latestmajor")]
[DataRow("EnableNETAnalyzers", "true")]
[DataRow("AnalysisLevel", "latest")]
[DataRow("Nullable", "enable")]
[DataRow("EnforceCodeStyleInBuild", "true")]
[DataRow("WarningsAsErrors", "Nullable")]
[DataRow("TreatWarningsAsErrors", "true")]
public void Mandatory_Project_Settings_Have_To_Be_Set(string elementName, string expectedValue)
```

The service rules check the "every service brings its own registration" convention from part one.
When a registration is missing, the message generates the extension method you should add.

## Your own rules: a separate project

Team-specific rules don't go into the generated project, which can be regenerated or updated. There's
a second project, `AspNetCore.MinimalApi.Sdk.CodeRules.Custom`, with the same `MsTestBase` and a
deliberately ignored starter rule:

```csharp
[Ignore] // remove me <3
[TestCategory("MyFirstTestCategory")]
[TestClass]
public class MyFirstCustomCodeRule : MsTestBase
{
    [TestMethod]
    public void My_First_Test_Should_Succeed()
    {
        /*
         * - Prioritize writing a multitude of simple tests over a few complex ones.
         * - Focus each test on a single issue.
         * - When reporting issues, provide comprehensive details necessary for resolution:
         *   the location of the error, its nature, and suggestions for correction.
         * ...
         */
    }
}
```

The comment in that file is a good summary of how to write rules at all: small, one concern per rule,
and a message that lets someone fix the problem without asking. Shipped rules get updated with
`runjit update coderules`, which opens a branch with the new rule set (described in the
[RunJit post](/blog/2024-clientgenerator-runjit-rulejit/)). Your custom rules are untouched.

## A lesson from practice: I ran the rules against the blueprint

For this post I ran the CodeRules project against the blueprint it ships with (on a copy of the
repository, November 2026). The result:
**112 passed, 20 failed**. That's not a disaster, and it's not a success either. It's a very honest
picture of what text-based rules are good at and where they hurt. The failures fall into three
groups.

### Group 1: real findings

- **`RJIT_CR_S_00002` – "Each service should register its dependencies too"** flagged
  `ErrorHandlingStrategy`. Its registration adds the strategy but none of the specific error handlers
  it depends on. That's exactly the bug from part one, where `Program.cs` calls
  `AddErrorHandlingMiddleware` and exceptions silently become empty `200` responses. The rule had
  found it. Nobody had looked.
- **`RJIT_CR_S_00001`** found eight services without a registration extension in their file, for
  example the Swagger options class and the `UpdateToDo` command.
- **`RJIT_CR_AA_00003`** found an async method returning `IEnumerable`, and the mutable-property
  rule for classes reported five findings.

### Group 2: rules that contradict each other or the generator

- **`Do_Not_Use_Partial_Classes`** flags `public partial class Program`, which
  `RJIT_CR_MAPI_00017` *requires* so that API tests can use `WebApplicationFactory<Program>`. It also
  flags every `JsonSerializerContext`, which **must** be partial, because the source generator emits
  the other half.
- **"No versions in class names"** flags `ToDoV1`, `ToDoV2` and `V1CommandBuilder`, all of them
  produced by the client and CLI generators from part two. The generators and the rules came from the
  same toolbox and still disagree.
- **`RJIT_CR_MAPI_00008`** wants a custom `…Response` type for every `Produces`, so it flags
  `typeof(Todo)` and also `typeof(ProblemDetails)` for 400 and 500. The first is a legitimate policy.
  The second contradicts the ProblemDetails standard the blueprint itself uses.

### Group 3: false positives from string matching

Eight of the 18 minimal API rules failed with the same six findings, and a ninth with eight. The
cause is the way `MinimalApiTestBase` collects "map statements":

```csharp
if (syntaxTreeStatement.SyntaxTree.Contains(".Map"))
{
    // treat as endpoint mapping
}
```

Anything containing `.Map` counts as an endpoint mapping. That includes `routeGroupBuilder.MapGetAll()`,
which is the blueprint's own helper that *calls* the real mapping, and `MapGroup("api/v{apiVersion:apiVersion}")`.
Rule after rule then complains that these "endpoints" have no `WithName`, no `Produces` and no
version. `RJIT_CR_MAPI_00001` even matched a **commented-out** `MapGroup` in the version `Startup`
files.

### What I take from it

- **Rules that aren't in the pipeline rot.** The blueprint wasn't kept green against its own rules,
  and after that, 20 red tests are noise, and the one real bug among them stays hidden. Run the
  rules in CI from day one and keep them green, or delete the ones you don't believe in.
- **Text matching is a fast start, not a foundation.** `Contains(".Map")` was a quick way to get 18
  rules working. A semantic check, "an invocation of `MapGet`/`MapPost`/… on an
  `IEndpointRouteBuilder`", wouldn't match helper methods or comments. That's the step my later work
  took with Roslyn analyzers and the Code Rule Engine, described in
  [self-defending codebases](/blog/2026-self-defending-codebases/).
- **Rules need tests too.** A fixture with one known-good and one known-bad endpoint per rule would
  have caught the `MapGetAll` false positive on the first run. In the blueprint, the place for that
  doesn't exist yet: the `CodeRules.Fixtures` project only contains the test environment.
- **Generators and rules must share one source of truth.** If a generator emits `ToDoV1`, either the
  generator or the rule is wrong, and the team should decide which, once.
- **Messages must stay readable.** The `S_00002` finding prints its "Should be" sample by calling
  `ToString()` on a parsed class record, so the right answer is buried under 60 lines of object dump.
  A rule whose message nobody can read is almost as bad as no rule.

## How it compares to other ways of enforcing conventions

| Mechanism | When it runs | Strength | Weakness |
|---|---|---|---|
| Review checklist / wiki | in review | zero setup | depends on attention, doesn't scale |
| `.editorconfig` and built-in analyzers | while typing, in build | instant feedback | limited to generic code style |
| Rules as unit tests (this post) | `dotnet test`, CI | any rule you can express as a query over the solution, including project files and SQL | text-based matching produces false positives, feedback only on test run |
| Roslyn analyzers with code fixes | while typing, in build | semantic, precise, can fix automatically | more effort per rule |

The test approach is the cheapest way to get from "wiki" to "enforced". Write the rule as a test
today, and promote the rules that matter most to analyzers later (see
[Roslynator and analyzers in CI](/blog/2026-roslynator-and-analyzers-in-ci/)).

## Pitfalls

- **Analyzing the rules themselves.** `MsTestBase` parses *all* projects, including test projects.
  Rules like "async methods need the `Async` suffix" then flag test methods, which by convention
  describe behaviour instead. Decide per rule whether test code is in scope.
- **One rule, many failures.** If a base class misidentifies what an endpoint is, every rule built on
  it fails at once. Test the base class's classification separately.
- **Fixes can't be "remove the rule".** If a rule is wrong, fix or delete it in a reviewed change,
  never by adding `[Ignore]` in the same pull request that violates it.

## Summary

- Turn the conventions page into **rules as tests**: a parsed solution, a LINQ query, an assertion.
- Give every rule a **stable ID**, a **reason**, the **location** and a **corrected sample**. That
  makes rules useful for people and for AI agents.
- Keep **custom rules in their own project** so the shipped set can be updated.
- **Run them in CI and keep them green.** Running them against the blueprint showed that a red rule
  set hides real bugs.
- Start with text matching if it gets you moving, then move the important rules to **semantic
  checks**, and test the rules themselves.
