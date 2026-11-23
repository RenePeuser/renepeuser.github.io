---
title: Self-defending codebases — making team rules executable
date: 2026-11-20
authors: rene
tags: [testing, roslyn, ai, dotnet]
excerpt: AI-generated code compiles, but does it follow your team's rules? A recap of our My Coding Zone session on CodeRules, Roslyn analyzers and a codebase that tells humans and agents what "how we do it here" means.
---

:::note[Talk recap]
Recap of the session at [My Coding Zone on 20 November 2026](/talks/my-coding-zone/), and the latest chapter of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

Tonight Philip Pregler and I were guests at [My Coding Zone](https://www.meetup.com/de-de/my-coding-zone/events/317174881/),
Gregor Biswanger's online community, live on Twitch. The session was in German. The title translates
to *"AI-generated code compiles, but does it follow your .NET rules?"*

This post is the written version for everyone who prefers reading code to watching a stream. All
snippets come from the companion repository
[my-coding-zone-20-11-2026](https://github.com/RenePeuser/my-coding-zone-20-11-2026).

## "That's not how we do it here"

Every team has rules. Records are immutable. Production projects never reference test projects.
Every service registers itself in the same file. Async methods end in `Async`. The trouble is where
those rules live:

| Where | Typical problem |
|---|---|
| People's heads | Knowledge leaves with people |
| Documentation | Outdated, hard to find, not executable |
| Code review | Late feedback, the same comments again and again |
| IDE settings | Not binding for the team, CI or agents |
| Prompts and skills | Context has to be supplied again, completely, every time |

A new team member learns these rules through review comments. An AI agent doesn't learn them at
all. It just produces code that compiles, much faster than a human, and the review queue fills up.

Our answer: turn team knowledge into **CodeRules**, executable checks that live in the repository,
run locally and in CI, and give the same result for the same input every time.

## What makes a good CodeRule

A rule is only as useful as its finding. A good finding answers five questions:

1. **What** is wrong?
2. **Where** is the violation (file and line)?
3. **Why** does the rule exist?
4. **How** do I fix it?
5. **How** do I verify the fix (the exact `dotnet test --filter ...` command)?

That last one is easy to forget and matters most for agents. It closes the loop.

## Stage 2: a rule is just a test

The demo repository tells the story in six stages, from parsing a solution with MSBuild and Roslyn
(stage 1) up to API snapshot tests (stage 6). The core starts at stage 2: a CodeRule is a plain MSTest
test that queries a model of the solution.

```csharp
[TestClass]
public class PROJECTS_RULE_001 : CodeRuleTestBase
{
    [TestMethod]
    public void Productive_Projects_Are_Not_Allowed_To_Reference_Any_Test_Project()
    {
        var testProjectNames = Solution.UnitTestProjects
                                       .Select(testProject => testProject.AssemblyName)
                                       .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);

        var findings = from project in Solution.ProductionProjects
                       from reference in project.ProjectReferences
                       where testProjectNames.Contains(reference.Name)
                       let projectFile = project.FileInfo
                       select new CodeRuleFinding
                       {
                           What = $"{project.AssemblyName} → {reference.Name}",
                           Where = projectFile,
                           Current = $"<ProjectReference Include=\"{reference.Include}\" />",
                           HowToFix = $"Remove the <ProjectReference> from '{projectFile.Name}'."
                       };

        Assert.That.CodeRuleHasNoFindings(findings,
                                          id: "PROJECTS_RULE_001",
                                          title: "Productive projects must not reference test projects",
                                          why: "Test projects are never deployed. ...",
                                          howToFix: "Remove the <ProjectReference> to the test project.");
    }
}
```

The model comes from [Solution.Parser](https://github.com/RenePeuser/Solution.Parser), my package
that puts MSBuild and Roslyn behind one API: projects, references, records, properties, invocations,
locations. A new rule like this takes minutes, not days. That's the main argument for starting with
tests. It's the same approach I used in 2024 with
[RunJit and RuleJIT](/blog/2024-clientgenerator-runjit-rulejit/), just with much better output.

## Stage 3 and 4: Roslyn analyzers and code fixes

Some rules deserve feedback *while typing*. For those, the repository contains real Roslyn analyzers
(`MCZ_ASYNC_*`, `MCZ_MAPI_*`, `MCZ_INLINE_*`) plus code fixes that repair a violation through a quick
action, for example adding a missing `.WithTags(...)` to a minimal API endpoint.

```csharp
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class MCZ_ASYNC_0001_AsyncMethodNamingAnalyzer : DiagnosticAnalyzer
{
    public const string DiagnosticId = "MCZ_ASYNC_0001";

    private static readonly DiagnosticDescriptor Rule = new(id: DiagnosticId,
                                                             title: "Methods returning Task/ValueTask must be named with an 'Async' suffix",
                                                             messageFormat: "Rename method '{0}' to '{0}Async'; methods returning Task, Task<T>, ValueTask or ValueTask<T> must use the 'Async' suffix",
                                                             category: "Async.Design",
                                                             defaultSeverity: DiagnosticSeverity.Error,
                                                             isEnabledByDefault: true);
    // ...
}
```

Unlike the 2024 version of the same rule, which matched on the *string* `"Task"`, the analyzer
compares symbols from the semantic model, so `Task`, `Task<T>`, `ValueTask` and `ValueTask<T>` are
recognized properly.

The trade-off is cost. An analyzer only sees the C# semantic model, needs more API knowledge and more
test code. A test-based rule can look at anything: csproj files, JSON, SQL, Markdown. So a rule
doesn't have to be born as an analyzer. The path we recommended:

1. **Observation**: a recurring mistake shows the need.
2. **Local test**: secure the expectation quickly and deterministically.
3. **Shared abstraction**: repeated boilerplate moves into an engine.
4. **Rule pack**: a general rule runs unchanged in several repositories.
5. **Analyzer**: only when instant IDE feedback justifies the extra effort.

:::caution[Visual Studio pitfall]
Our minimal API analyzers ship with severity `Info` and are switched on per repository in
`.editorconfig`. Don't ship them disabled by default: Visual Studio's live analysis skips analyzers
that are disabled by default, even if `.editorconfig` enables them. Build and Rider still report
them, but the squiggles in the editor are missing.
:::

## Stage 5: the Code Rule Engine

Stage 2 works, but every rule repeats test plumbing, and each team ends up writing its own base class
and output renderer. Stage 5 runs the **same ten rules with the same IDs** on a Code Rule Engine. A
rule is now just a class that evaluates and returns findings:

```csharp
public sealed class RecordPropertiesMustBeImmutable : ICodeRule
{
    public string Id => "RECORDS_RULE_001";

    public string Title => "Record properties must be immutable";

    public string Why => "A record is a snapshot of a state, e.g. data loaded from the database. ...";

    public string HowToFix => "Replace 'set;' with 'init;' and create a modified copy with a 'with' expression.";

    public ImmutableList<string> Tags => ["Records"];

    public IEnumerable<Finding> Evaluate(CodeContext context)
    {
        return from record in context.Records
               from property in record.Properties
               where !property.IsReadOnly
               select new Finding
               {
                   What = property.FullyQualifiedName,
                   Where = property.Location,
                   Current = property.SourceCode,
                   ShouldBe = property.SourceCode.Replace("set;", "init;", StringComparison.Ordinal)
               };
    }
}
```

A project needs exactly one setup class. A source generator reads the registrations at build time
and writes one MSTest test per rule. A guard test fails if a registered rule didn't get a test:

```csharp
public sealed class CodeRuleSetup : ICodeRuleSetup
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddCodeRuleEngine("code-rules.slnx",
                                   options => options.AddRulePack<MyCodingZoneRulePack>()
                                                     .UseOutputMode(CodeRuleOutputMode.Human));
    }
}
```

The solution is parsed once per run and rules execute in parallel. Exceptions need a
`[SuppressMessage]` with a mandatory justification instead of a hidden whitelist. And a rule pack
can be shared across repositories.

## Rules need tests too

The part I like most: rules get their own tests, written against inline code with `[| ... |]`
markers for exactly where a finding is expected.

```csharp
[TestMethod]
public async Task Should_Report_Record_Property_When_It_Has_A_Setter()
{
    await Assert.That.CodeRule.ViolatesAsync<RecordPropertiesMustBeImmutable>("""
        public record Order(int Id)
        {
            [|public string Status { get; set; } = "";|]
            [|public int Count { get; set; }|]
        }
        """);
}
```

The engine is strict about finding quality: `Current` must be exactly the source text at `Where`,
because a fix replaces that span with `ShouldBe`. While porting stage 2 to stage 5, these tests caught
real inaccuracies. One rule, `SERVICES_RULE_003`, reported the class instead of the offending
parameter.

## AI writes rules, humans set the bar

This is where the title comes back. Every finding can render in two modes. Human mode is a framed,
readable report. AI mode is JSON with a stable schema, including the rerun command and an explicit
instruction:

```csharp
Rerun = $"dotnet test src/MyCodingZone.CodeRules.Test --filter \"FullyQualifiedName~{violation.Id}\"",
Instructions = "Fix the code, not the rule. Do not weaken the rule, add exceptions or [Ignore] without human approval. " +
               "Use 'rerun' to check your fix."
```

The repository also ships agent skills: `/code-rule-with-engine` and `/code-rule-as-test` let an AI
agent create a new rule **including its tests and documentation page**. The skills are deliberately
strict. Pin down *what*, *scope*, *why* and *fix* in one sentence each, and *"if the scope or the
fix is unclear, ask. Do not guess a rule."*

That split is the whole point. The agent does the typing: rule class, `[| |]` test cases, docs page.
The human decides *which* rules exist and how strict they are. Once a rule is merged, it guards every
future change, whether a person or an agent wrote it.

The CI pipeline makes that order visible. Build, then the CodeRule tests, then everything else:

```yaml
- name: CodeRule tests (stage 2 and stage 5)
  run: dotnet test code-rules.slnx --no-build --filter "TestCategory~CodeRules"

- name: All other tests
  run: dotnet test code-rules.slnx --no-build --filter "TestCategory!~CodeRules"
```

## Pick the simplest reliable mechanism

Not everything needs a Roslyn analyzer. The rule of thumb from the companion repository:

| Need | Mechanism |
|---|---|
| Types and attributes | Reflection test |
| Project and package rules | MSBuild or solution test |
| C# semantics while typing | Roslyn analyzer |
| Automatic repair | Analyzer with code fix |
| XAML, SQL, JSON, Markdown | Parser + CodeRule test |
| Runtime behavior of an API | API or integration test (stage 6 uses [AspNetCore.Simple.MsTest.Sdk](/blog/2021-aspnetcore-simple-mstest-sdk/)) |

## What's next

Looking back over this series, the line from my early test helpers through RunJit to tonight is
fairly straight. Every step moved knowledge out of people's heads and into something that runs. What
changed in 2026 is the pressure. When code arrives at agent speed, review can't be the only place
rules are enforced.

My takeaways:

- **Start with a test, not an analyzer.** Minutes per rule beat perfect IDE integration you never
  get to.
- **The finding is the product.** What, where, why, how to fix, how to verify, for humans and
  agents alike.
- **Test your rules.** A rule that reports the wrong span will produce wrong fixes.
- **Let AI write rules, not lower them.** Humans own the bar. Agents help raise it.

The code is on [GitHub](https://github.com/RenePeuser/my-coding-zone-20-11-2026), and the material
also has a companion repository from [BASTA! Autumn 2026](https://github.com/RenePeuser/basta-autumn-2026).
Thanks to My Coding Zone for hosting us.
