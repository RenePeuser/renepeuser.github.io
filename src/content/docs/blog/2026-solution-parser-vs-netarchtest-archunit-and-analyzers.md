---
title: Solution.Parser, NetArchTest, ArchUnitNET or a Roslyn analyzer — which one for which rule?
date: 2026-11-24
authors: rene
tags: [dotnet, solution-parser, architecture-tests, roslyn, code-rules]
excerpt: There's more than one way to make a team rule executable in .NET, and each tool sees a different part of the codebase. An honest comparison of Solution.Parser with NetArchTest, ArchUnitNET and Roslyn analyzers, the same rule written in each, and the mix I actually use.
---


I wrote [Solution.Parser](https://github.com/RenePeuser/Solution.Parser), so take this post with the
appropriate pinch of salt. But I also use the other tools, and I'd rather you pick the right one than
mine for everything. The question isn't "which tool is best". It's **"what does this rule need to
see, and when should it fail?"**

This is the last post of the series. The earlier ones covered
[getting started](/blog/2026-solution-parser-your-solution-as-a-queryable-model/),
[the code model](/blog/2026-solution-parser-reading-code-like-code/) and
[project and XAML rules](/blog/2026-solution-parser-architecture-tests-for-projects-and-xaml/).

## Four tools, four views of the codebase

The tools differ less in syntax than in **what they read**:

| | Reads | Sees | Fails |
|---|---|---|---|
| [NetArchTest](https://github.com/BenMorris/NetArchTest) | compiled assemblies (IL) | types, namespaces, dependencies between types | in a unit test |
| [ArchUnitNET](https://github.com/TNG/ArchUnitNET) | compiled assemblies (IL) | types, members, dependencies, attributes, layers | in a unit test |
| Roslyn analyzer | source, inside the compiler | everything the compiler sees, one compilation at a time | while typing and on build |
| Solution.Parser | sln/slnx, csproj, C# source, XAML, nuspec | projects, packages, statements, expressions, markup; symbols on demand | in a unit test |

That table explains most of the trade-offs below. A tool that reads IL can't see a `#pragma`, an
`else` after a `return`, an interpolated string passed to a logger, or anything in a `.csproj` or a
`.xaml` file. A tool that reads source one compilation at a time can't easily check a rule that spans
projects. A tool that runs in a test can't put a squiggle under your code while you type.

## The same rule in each tool

The classic layering rule: *the domain doesn't depend on infrastructure.*

**NetArchTest**, over the compiled domain assembly:

```csharp
var result = Types.InAssembly(typeof(Order).Assembly)
                  .That().ResideInNamespace("Shop.Domain")
                  .ShouldNot().HaveDependencyOn("Shop.Infrastructure")
                  .GetResult();

Assert.IsTrue(result.IsSuccessful, string.Join(", ", result.FailingTypeNames ?? []));
```

**ArchUnitNET**, with an architecture loaded once:

```csharp
private static readonly Architecture Architecture =
    new ArchLoader().LoadAssemblies(typeof(Order).Assembly, typeof(OrderRepository).Assembly).Build();

[TestMethod]
public void Domain_Does_Not_Depend_On_Infrastructure()
{
    IArchRule rule = Types().That().ResideInNamespace("Shop.Domain")
                            .Should().NotDependOnAny(Types().That().ResideInNamespace("Shop.Infrastructure"));

    rule.Check(Architecture);
}
```

**Solution.Parser**, on the project level:

```csharp
var findings = from reference in Solution.Project("Shop.Domain").ProjectReferences
               where reference.Name.Contains(".Infrastructure", StringComparison.Ordinal)
               select $"Shop.Domain references {reference.Name}";

findings.ShouldBeEmpty("The domain must not depend on infrastructure");
```

For this particular rule, all three are fine, and the IL-based tools have an edge: they see the
*actual* dependencies after compilation, including ones that come in through a fully qualified name
with no `using` and no project reference in sight. If layering between types is all you need,
NetArchTest is the smallest step and ArchUnitNET the most expressive one.

## Where the IL-based tools stop

Now a rule from a real review checklist: *log with a message template, not an interpolated string.*

```csharp
logger.LogInformation($"Order {order.Id} placed by {customer.Name}");   // what the rule should find
logger.LogInformation("Order {OrderId} placed by {Customer}", order.Id, customer.Name);
```

In IL, both are calls to `LogInformation` with a string. The interpolation has been compiled into a
`DefaultInterpolatedStringHandler` or a `string.Format` call. An assembly-based tool has no reasonable
way to tell the two apart. In Solution.Parser, it's the expression's kind:

```csharp
from call in trees.Invocations
where call.Name.StartsWith("Log", StringComparison.Ordinal)
   && call.Arguments.Any(a => a.Kind == ExpressionKind.InterpolatedString)
select $"{call.Location}: {call.Name} with an interpolated string loses the structure, pass a template";
```

The same goes for most rules about **how code is written** rather than what it depends on:

- an `else` after a branch that returns,
- `throw ex;` instead of `throw;`,
- `await` inside a `foreach`, `SaveChanges` inside a loop,
- `#pragma warning disable` without a reason,
- a `switch` expression without a `_` arm,
- `== null` instead of `is null`.

And everything that isn't C# at all: project references, package versions, test projects referenced
from production, a binding path in XAML that doesn't exist on its view model. None of that is in an
assembly.

## Where Solution.Parser stops

To be fair in the other direction:

- **No feedback while typing.** A Solution.Parser rule fails when the tests run. If a developer
  should see the problem the moment they type it, that's an analyzer's job.
- **No code fix.** A finding tells you where and what to do instead. It doesn't rewrite the code with
  a light bulb.
- **Syntax first.** Without symbols, matching goes by the written name: a class of your own called
  `List` counts as a collection. `ParseMode.WithSymbols` fixes that, but it needs a restored solution
  and takes longer.
- **It's a test run, not an incremental build.** On a very large solution, parsing everything takes
  seconds rather than milliseconds. It's cached within a run, but it's not free.
- **Maintained by one person.** I'm committed to it and it has a fair number of NuGet downloads, but
  it's not backed by a company the way Roslyn is.

## Roslyn analyzers: unbeatable feedback, real cost

Analyzers are the gold standard for feedback. The squiggle appears while typing, the build fails with
`TreatWarningsAsErrors`, and a code fix can repair the violation in one click. The compiler's semantic
model is right there.

The cost is everything around it: a `netstandard2.0` project, packaging or analyzer references, a test
harness of its own, and care about performance because the analyzer runs on every keystroke in every
open file. I wrote about that trade-off in my
[2017 post on Roslyn analyzers](/blog/2017-roslyn-analyzers-and-argument-checks/). For a rule that
fires daily and has an obvious fix, it's worth it. For the long tail of team conventions, most of them
never get written that way.

## A decision guide

| The rule… | Pick |
|---|---|
| is about dependencies between types or namespaces, nothing else | NetArchTest (simple) or ArchUnitNET (expressive) |
| is about how code is written: statements, expressions, patterns, logging, async | Solution.Parser |
| involves project or package references, test projects, target frameworks | Solution.Parser |
| involves XAML, or checks markup against C# | Solution.Parser |
| spans several projects ("every endpoint has a test", "every DTO is mapped") | Solution.Parser |
| should be visible while typing, fires often and has an obvious automatic fix | Roslyn analyzer + code fix |
| is new and you're not sure it's right yet | Solution.Parser first, analyzer later if it earns it |

That last row is the one I use most. Writing a rule as a test takes minutes, so it's cheap to find out
whether a rule is actually right: whether it has false positives, whether the team agrees with it,
whether it fires at all. The few rules that prove themselves *and* fire often enough to deserve
feedback while typing get promoted to an analyzer.

## The mix I actually use

In practice, a mature codebase I work on ends up with layers:

```mermaid
flowchart LR
    A["Built-in .NET analyzers<br/>+ .editorconfig"] --> B["A few custom analyzers<br/>with code fixes"]
    B --> C["Solution.Parser rule suite<br/>(the long tail)"]
    C --> D["Code review<br/>(judgement only)"]
```

- **Built-in analyzers and `.editorconfig`** for everything Microsoft already ships: nullability,
  `ConfigureAwait`, naming, formatting.
- **A handful of custom analyzers** for the rules that fire constantly and have a mechanical fix.
- **A Solution.Parser rule suite** for the long tail: team conventions, project structure, XAML,
  cross-project checks. Often dozens of rules, each a few lines.
- **Code review** for what actually needs human judgement: naming that's technically fine but
  misleading, design trade-offs, whether the code solves the right problem.

The goal is that reviewers stop writing the same comment for the fifth time, and that an AI agent gets
a clear, located, actionable message instead of a wiki page it never reads. The talk recap
[Self-defending codebases](/blog/2026-self-defending-codebases/) shows that whole pipeline, from a rule
as a test to analyzers and code fixes, and
[RunJit and RuleJIT](/blog/2024-clientgenerator-runjit-rulejit/) is where the idea of pushing rule
suites into many repositories started.

## Pitfalls

- **Picking one tool for everything.** An analyzer for a rule that fires once a quarter is wasted
  effort. A test for a rule that fires ten times a day is slow feedback.
- **Comparing tools on the layering rule only.** Every tool handles "domain doesn't reference
  infrastructure". The differences show up in the second and third rule.
- **Duplicating a rule across tools.** If a rule moves from a test to an analyzer, delete the test.
  Two sources of truth drift.
- **Rules without an owner.** Whatever the tool, a rule that nobody can explain gets suppressed. Every
  rule needs a reason in its message.

## Summary

- IL-based tools (NetArchTest, ArchUnitNET) are excellent for type and namespace dependencies, and
  they see dependencies the source hides.
- They can't see how code is written, nor projects, packages or XAML. That's where Solution.Parser
  is strongest.
- Roslyn analyzers give the best feedback, at the highest cost per rule. Reserve them for rules that
  fire often and have an automatic fix.
- Start a new rule as a Solution.Parser test, find out if it's right, and promote it to an analyzer
  only if it earns it.

Solution.Parser is on [GitHub](https://github.com/RenePeuser/Solution.Parser) and
[NuGet](https://www.nuget.org/packages/Solution.Parser/). The README's cookbook is the fastest way to
your first rules, and every sample in it runs as a test, so what you copy works.
