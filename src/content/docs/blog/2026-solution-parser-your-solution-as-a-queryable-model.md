---
title: Your solution as a queryable model — code rules as LINQ with Solution.Parser
date: 2026-11-24
authors: rene
tags: [dotnet, solution-parser, architecture-tests, code-rules, testing]
excerpt: The team guideline says "no DateTime.Now", and code review finds it again every other week. Solution.Parser turns the whole solution into a typed model you query with LINQ, so a rule like that becomes a five-line unit test with clickable findings. How to get started, how to structure a rule suite, and how to prove a rule actually catches something.
---


Every team I've worked with has a page called something like *Coding Guidelines*. Inject the clock
instead of calling `DateTime.Now`. Don't `new` up an `HttpClient`. Awaitable methods end in `Async`.
Records are immutable. Everyone agrees with the page. Nobody reads it twice.

So the rules get enforced in the only place left: **code review**. A reviewer spots `DateTime.Now`,
writes the same comment for the fifth time, and next sprint someone else writes it again. With
AI-generated code the problem gets worse, because an agent doesn't read wiki pages at all.

This series is about [Solution.Parser](https://github.com/RenePeuser/Solution.Parser) (on
[NuGet](https://www.nuget.org/packages/Solution.Parser/)), the library I've been building since 2016
to make that kind of rule executable. This first post shows the core idea and how to get a first rule
running in a test project.

## The idea: a rule is a query plus an assertion

Solution.Parser reads a whole solution, its projects, its C# code and its XAML, into a typed model
that's made to be queried with LINQ. A code rule is a query over that model and an assertion that it
finds nothing:

```csharp
using Solution.Parser.Core;     // ShouldBeEmpty
using Solution.Parser.CSharp;   // the C# model and its queries
using Solution.Parser.Sln;      // SolutionFile

var solution = SolutionFile.Find("MySolution.sln");   // searched upwards from the running test

var findings = from member in solution.ProductionTrees.MembersWithBody
               from access in member.MemberAccesses
               where access.Target == "DateTime" && access.Name is "Now" or "UtcNow" or "Today"
               select $"{access.Location}: inject TimeProvider instead of {access.SourceCode}";

findings.ShouldBeEmpty("Inject the clock: DateTime.Now cannot be tested");
```

That's the whole rule. It reads the way you'd say it out loud: *in every member with a body, find
member accesses on `DateTime` named `Now`, `UtcNow` or `Today`*. No `SyntaxKind`, no visitor, no
semantic model unless you ask for one.

When the rule fails, every finding is one line in `path(line,column): message` format, which test
runners and IDEs turn into a clickable link:

```text
Inject the clock: DateTime.Now cannot be tested. 2 findings:
  D:\repo\src\Orders\OrderService.cs(41,27): inject TimeProvider instead of DateTime.Now
  D:\repo\src\Billing\InvoiceFactory.cs(18,22): inject TimeProvider instead of DateTime.UtcNow
```

That output format matters more than it looks. A failing rule doesn't just say "something is wrong
somewhere". It says *where*, and what to do instead. That's useful for a developer, and it's exactly
what an AI agent needs to fix the violation on its own.

## Before: the same rule as a Roslyn analyzer

For comparison, here's roughly what the same check costs as a classic Roslyn analyzer, and this is the
short version:

```csharp
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NoDateTimeNowAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEAM001", "Inject the clock", "Inject TimeProvider instead of {0}",
        "Design", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => [Rule];

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.SimpleMemberAccessExpression);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var access = (MemberAccessExpressionSyntax)context.Node;
        if (access.Expression is IdentifierNameSyntax { Identifier.Text: "DateTime" } &&
            access.Name.Identifier.Text is "Now" or "UtcNow" or "Today")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, access.GetLocation(), access.ToString()));
        }
    }
}
```

Plus a separate analyzer project targeting `netstandard2.0`, a package or analyzer reference, and its
own test project. Analyzers are great when you need feedback while typing (more on that in
[the last post of this series](/blog/2026-solution-parser-architecture-rules-for-the-whole-solution/)). But for the
long tail of team rules, that ceremony is why most of them never get written.

## Getting started

Add the package to a test project. One package ships, `Solution.Parser`, and it contains everything:
the solution and project reader, the C# parser, the symbol layer, XAML and NuGet support.

```xml
<ItemGroup>
  <PackageReference Include="Solution.Parser" Version="7.*" />
</ItemGroup>
```

Then find the solution. `SolutionFile.Find` searches upwards from the directory of the running test
assembly, which for a test project is somewhere inside the repository:

```csharp
SolutionFile.Find("MySolution.sln")    // exactly that file
SolutionFile.Find("MySolution.slnx")   // exactly that file
SolutionFile.Find("MySolution")        // either of both, '.slnx' wins when both exist side by side

SolutionFile.Find("MySolution.sln", startDirectory: new DirectoryInfo(@"D:\repo"))   // search from elsewhere
```

Both the classic `.sln` and the newer XML-based `.slnx` format work. Everything behind `Find` is format
agnostic.

## What the solution hands you

The solution model separates production code from test code, which is what most rules want:

```csharp
solution.Projects                       // every project
solution.ProductionProjects             // the ones that are not test projects
solution.UnitTestProjects
solution.Project("My.Sample")           // by name; an unknown name lists the ones there are

solution.AllTrees                       // the C# code of every project, parsed once and cached
solution.ProductionTrees
solution.UnitTestTrees
project.Trees

project.Name                            // "My.Sample"
project.Path                            // D:\repo\src\My.Sample\My.Sample.csproj
project.PackageReferences               // Include and Version
project.ProjectReferences
```

Two details make this pleasant in practice:

- **Everything is parsed once and cached.** `solution.ProductionTrees` hands out the same list every
  time, and the lists on it (`Methods`, `Properties`, `Invocations`, …) are built on first use and then
  kept. Fifty rules over the same solution don't parse it fifty times.
- **A list of files has the same lists as a single file.** `tree.Methods` gives you the methods of
  one file, `solution.ProductionTrees.Methods` the methods of all of them. A rule doesn't need a
  `SelectMany` dance to go from one file to the whole codebase.

## A base class for a rule suite

Once you have more than a handful of rules, give them a shared setup. The solution is parsed once per
test run:

```csharp
[TestClass]
public abstract class CodeRuleBase
{
    protected static SolutionFile Solution { get; private set; } = null!;

    [AssemblyInitialize]
    public static void Init(TestContext _) => Solution = SolutionFile.Find("MySolution.sln");
}

[TestClass]
public class Records : CodeRuleBase
{
    [TestMethod]
    public void Record_Properties_Have_To_Be_Immutable()
    {
        var findings = from tree in Solution.ProductionTrees
                       from record in tree.Records
                       from property in record.Properties
                       where !property.IsReadOnly
                       select $"{property.Location}: {record.FullyQualifiedName}.{property.Name} should be {{ get; init; }}";

        findings.ShouldBeEmpty("Record properties must be immutable");
    }
}
```

The test name is the rule. The message says what to do. The location says where. That's all a
violation report needs.

A note on the record rule: positional records like `record Order(string Id, List<Line> Lines)` list
their parameters in `Properties` too, marked `IsPositional`. That was a gap in older versions, and it's
the kind of thing you only notice when a rule silently misses half the codebase.

## Prove that the rule catches something

A rule that never fails proves nothing. Maybe the codebase is clean, maybe the query has a typo and
matches nothing at all. You can't tell from a green test.

So every rule deserves a test against code that's deliberately broken. `CodeBase.FromSource` parses
code from a string, with the same API as a real solution:

```csharp
[TestMethod]
public void The_Clock_Rule_Finds_DateTime_Now()
{
    var code = CodeBase.FromSource("""
        public class Billing(TimeProvider clock)
        {
            public DateTime Due => DateTime.Now.AddDays(30);
            public DateTimeOffset Today() => clock.GetUtcNow();
        }
        """);

    var findings = from member in code.AllTrees.MembersWithBody
                   from access in member.MemberAccesses
                   where access.Target == "DateTime" && access.Name is "Now" or "UtcNow" or "Today"
                   select access.SourceCode;

    Assert.AreEqual("DateTime.Now", findings.Single());
}
```

`CodeBase.FromSources(("A.cs", a), ("B.cs", b))` takes several files when a rule spans more than one.
Solution.Parser does this for its own documentation: every rule in the README's cookbook runs word for
word against broken and correct code in `ReadmeSamplesTest` and `ReadmeSemanticSamplesTest`. If the
API changes, the README can't silently go stale.

## Where these tests live

I put code rules in their own test project, next to the unit tests but separate from them:

| | Unit tests | Code rules |
|---|---|---|
| What they check | behaviour of a class | shape of the codebase |
| Input | objects you construct | the solution on disk |
| Typical failure | "expected 42, got 41" | "3 findings, here they are" |
| Who fixes it | whoever broke the behaviour | whoever wrote the violating code |
| Runs | on every build | on every build, same `dotnet test` |

Because they're plain tests, they need no extra tooling in CI. They run where the unit tests run, and
they fail the build the same way.

## Pitfalls

- **Test project detection.** `ProductionProjects` and `UnitTestProjects` are split by
  `<IsTestProject>true</IsTestProject>` or a reference to a known test package (`MSTest.*`,
  `Microsoft.NET.Test.Sdk`, `NUnit`, `xunit`). A test helper library without either counts as
  production code. Set `IsTestProject` explicitly in shared test infrastructure.
- **Rules that are too clever.** A rule with three nested conditions and a regex is hard to trust and
  harder to fix. If a rule needs a paragraph to explain, split it.
- **Rules without a "what to do instead".** "Violation found" isn't actionable. Every message should
  name the alternative: *inject `TimeProvider`*, *use `IHttpClientFactory`*, *write `throw;`*.
- **Starting with fifty rules.** Turn on a rule, fix or explicitly exclude what it finds, then add the
  next. A rule suite that's red on day one gets ignored on day two.

## Summary

- Solution.Parser reads a solution, its projects, C# and XAML into a typed, cached model you query
  with LINQ.
- A code rule is a query plus `ShouldBeEmpty`. The failure lists every finding with a clickable
  `path(line,column)` and a message that says what to do.
- No analyzer project, no `SyntaxKind`, no visitor. A new rule takes minutes, which is why rules
  actually get written.
- Test each rule against deliberately broken code with `CodeBase.FromSource`, because a rule that
  never fails proves nothing.

The [next post](/blog/2026-solution-parser-reading-code-like-code/) goes into the model itself:
statements, expressions, patterns, types taken apart, and what changes when the compiler's symbols
join in. For the history of how this started, see
[Testing the solution itself](/blog/2019-testing-the-solution-itself/), and for how these rules fit
into a larger enforcement strategy, [Self-defending codebases](/blog/2026-self-defending-codebases/).
