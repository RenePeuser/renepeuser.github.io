---
title: Generating clients and running code just-in-time — ClientGenerator, RunJit and RuleJIT
date: 2024-02-17
authors: rene
tags: [retrospective, roslyn, codegen, dotnet, aspnetcore]
excerpt: Between Christmas 2022 and spring 2024 a weekend client generator grew into a CLI that scaffolds APIs, generates clients and pushes executable code rules into repositories. The common idea is to read the code you already have and generate the rest.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2024. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

On 17 February 2024 I created a repository called `RunJit.Cli`. It wasn't really a new idea. It
was the next step of something that had started over Christmas 2022, and it ended up connecting
three ideas I'd been working on separately:

- **generate** code from code that already exists (clients, CLIs, tests);
- **automate** the repetitive steps around a solution (new projects, updates, fixes);
- **check** the result with rules that run as tests.

This post goes through how those pieces fit together, and why the third one turned out to matter
most.

## Christmas 2022: a client generator

The first commit of `AspNetCore.Simple.ClientGenerator` is dated 24 December 2022. The commit
messages from that day describe the plan quite precisely: *"introduce solution path and solution
parsing, add target folder for creation, and swagger fetching local and from url"*. Two days later:
*"introduce code parser, syntaxtree parser"*.

The motivation was simple. Every ASP.NET Core API I worked on needed a typed .NET client, for
integration tests, for other services, sometimes for a CLI. Writing those clients by hand meant
copying routes, DTOs and status codes from the server into a second place, where they quietly drifted
apart.

The server already knows all of that. So the generator reads it, from one of two sources:

- **the solution itself**, parsed with Roslyn: controllers, minimal API `Map*` calls, attributes,
  `Produces(...)` metadata, request and response types;
- **an OpenAPI JSON file**, for APIs where the source isn't available.

Under the hood both are strategies behind one small interface. The generator picks exactly one and
fails loudly otherwise:

```csharp
interface ISpecificClientGenerator
{
    bool CanHandle(Client client);
    Task GenerateClientAsync(Client client, FileInfo clientSolution);
}

internal sealed class ClientCreator(IEnumerable<ISpecificClientGenerator> clientGenerators)
{
    internal async Task GenerateClientAsync(Client client, FileInfo clientSolution)
    {
        var canHandler = clientGenerators.Where(g => g.CanHandle(client)).ToImmutableList();

        if (canHandler.Count <= 0)
        {
            throw new InvalidOperationException("No strategy was found to handle the client gen request");
        }

        if (canHandler.Count > 1)
        {
            throw new InvalidOperationException("Multiple strategies were found to handle the client gen request");
        }

        await canHandler[0].GenerateClientAsync(client, clientSolution).ConfigureAwait(false);
    }
}
```

The parsing side relies on [Solution.Parser](https://github.com/RenePeuser/Solution.Parser), a
package I had started in April 2022 that puts MSBuild (solutions, projects) and Roslyn (syntax trees)
behind one model. That package comes back later in this series.

## What the generated code looks like

The output is deliberately boring. One facade per domain, one class per API version, one method per
endpoint, all routed through a shared `IHttpCallHandler`. The method template is tiny:

```text
        $attributes$
        public $returnType$ $name$($parameters$)
        {
            return httpCallHandler.CallAsync$returnTypeNoTask$(HttpMethod.$httpMethod$, $$url$, $payloadAsJson$, $cancellationToken$);
        }
```

My public sample repository [AspNetCore.MinimalApi.Sdk](https://github.com/RenePeuser/AspNetCore.MinimalApi.Sdk)
from May 2024 shows the full round trip. The server defines a versioned minimal API endpoint:

```csharp
return routeGroupBuilder.MapGet("todos", ([FromServices] GetAllToDosQuery getAllToDosQuery) =>
                        {
                            return Results.Ok(getAllToDosQuery.Execute());
                        })
                        .Produces(200, typeof(IEnumerable<Todo>))
                        .Produces(400, typeof(ProblemDetails))
                        .WithName("getAllToDosV1")
                        .WithTags("ToDo")
                        .MapToApiVersion(1);
```

and the generated client in the same repository contains the matching, versioned call:

```csharp
public class ToDoV2
{
    private readonly IHttpCallHandler _httpCallHandler;

    public ToDoV2(IHttpCallHandler httpCallHandler)
    {
        _httpCallHandler = httpCallHandler;
    }

    public Task<Todo> GetAllToDosAsync()
    {
        return _httpCallHandler.CallAsync<Todo>(HttpMethod.Get, "api/v2.0/todos", null, CancellationToken.None);
    }
}
```

The same repository also contains a generated **.NET global tool** for the API (`myapi todo v1 ...`),
built from the same endpoint model. An architecture decision record in the CLI explains the command
shape: the version becomes a subcommand and everything else goes into the JSON payload, so a
developer gets guided help at every level instead of a wall of options.

:::note
The generator never had to understand *business logic*. It only reads the contract metadata the
endpoints already declare. That is why endpoint conventions (tags, names, versions, `Produces`)
matter so much. They are the input for everything downstream.
:::

## From generator to CLI: RunJit

Once the solution parsing and the template engine existed, other tasks fit the same mould: read a
solution, apply templates, write files, verify the result builds. The client generator turned into a
general CLI, and in February 2024 it became `RunJit.Cli`.

The name isn't mine, by the way. When I showed my little Christmas generator to
[Philip Pregler](https://www.linkedin.com/in/philip-pregler/), who is a friend, a colleague and a
customer all at once, we ended up discussing it for far longer than either of us had planned. Somewhere
in that discussion he came up with the name: **RunJit, short for "Runs Just in Time"**. It stuck
immediately, and every tool that came after it inherited the "Jit": RunJit.Api,
RuleJIT. Good names are rare; when a friend hands you one, you take it. 😄

The command tree reflects what I kept doing by hand on every project:

| Area | Commands (excerpt) |
|---|---|
| `new` | `minimal-rest-api`, `minimal-api-serverless`, `nuget-project`, `lambda` |
| `generate` | `client`, `.nettool`, `custom-endpoint` |
| `update` | `.net`, `nuget`, `globaljson`, `buildconfig`, `coderules`, `swaggertests` |
| `fix` | `embeddedresource`, `projects` |
| others | `cleanup code`, `localize strings`, `rename solution`, `migrate endpoints` |

Nearly every command has a **system test**, and most of them follow the same pattern: create a fresh Web
API with the CLI, apply the command, then prove that the result still compiles:

```csharp
[TestMethod]
public async Task Generate_Client_For_Simple_Rest_Endpoint()
{
    // 1. Create new Web Api
    var solutionFile = await Mediator.SendAsync(new CreateNewSimpleWebApi("Runjit.ClientGen", WebApiFolder, BasePath)).ConfigureAwait(false);

    // 2. Create Web-Api endpoints
    await Mediator.SendAsync(new CreateSimpleRestController(solutionFile, Resource, false)).ConfigureAwait(false);

    // 3. Generate client for endpoint
    await Mediator.SendAsync(new GenerateClient(solutionFile)).ConfigureAwait(false);

    // 4. Test if generated results is buildable
    await DotNetTool.AssertRunAsync("dotnet", $"build {solutionFile.FullName}").ConfigureAwait(false);
}
```

"It builds" is a low bar for generated code, but it's a bar you can automate, and it catches most
template mistakes immediately. The help output of the commands is snapshot-tested as well.

A month later `RunJit.Api` joined: a small ASP.NET Core API (deployable as a Lambda) that serves
templates to the CLI, for example the client templates and an export of the code rules. Its own
.NET client follows the same structure as the generated ones.

## RuleJIT: rules as tests

The third piece started in January 2024 in a separate repository, RuleJIT. Its first real commit
message is *"neutralize code rules -> no dependencies"*. The goal was to take rules that had grown
inside individual projects and turn them into a reusable set.

Each rule is an MSTest test that runs LINQ queries over the parsed solution. The very first one, in
slightly shortened form (namespace neutralized):

```csharp
namespace RunJit.CodeRules
{
    [TestCategory("Coding-Rules")]
    [TestCategory("AsyncAwait")]
    [TestClass]
    public class RJIT_CR_AA_C_00001 : MsTestBase
    {
        [TestMethod]
        public void All_Classes_Which_Return_A_Task_Should_Have_Post_Fix_Async()
        {
            var returnAwaitOnly = (from @class in Classes
                                   from method in @class.Methods
                                   where method.ReturnParameter.Contains("Task") &&
                                         method.Name.EndWith("Async").IsFalse() &&
                                         method.Name.NotEqualsTo("Handle") &&
                                         method.Name.NotEqualsTo("Main") &&
                                         method.Attributes.All(a => a.Name.DoesNotContain("TestMethod"))
                                   select new { ErrorClass = @class.FullQualifiedName, ErrorMethod = method.Name })
                                  .ToImmutableList();

            Assert.IsTrue(returnAwaitOnly.IsEmpty(),
                          $"Documentation: {DocumentationDomain}#RJIT_CR_AA_00001 ...");
        }
    }
}
```

A few design choices from that repository are still in my toolbox:

- **Stable rule IDs** (`RJIT_CR_AA_00001`, `RJIT_CR_CSPROJ_00001`, ...) with a documentation anchor
  per rule, linked from the failure message.
- **Rules about more than C#.** `MsTestBase` exposes classes, records, enums and interfaces, but also
  project files, JSON files and SQL scripts found in the solution.
- **Tests for the rules themselves.** A separate test project feeds known-good and known-bad code
  snippets into the rules.
- **Experimental "self-healing" fixtures.** For some rules a fixture project could rewrite the
  offending code, for example appending `Async` to method names. Regex-based and blunt, but it
  showed the direction: a rule that knows the fix.

The connection to the CLI is `runjit update coderules`. It takes a local solution (or clones a list
of repositories), creates a branch called `quality/update-coderules`, adds the rule project to the
solution under a `CodeRules` folder, adapts it to the target solution, then commits and pushes the
branch. The system test for the command checks that the solution still builds afterwards. From then
on the rules run with every `dotnet test`, locally and in CI.

## The common thread

Looking back, all three tools do the same thing in different directions:

| Tool | Reads | Produces |
|---|---|---|
| Client generator | endpoint metadata | typed clients, a CLI |
| RunJit CLI | solution structure | new projects, updates, fixes |
| RuleJIT | the whole solution | findings, sometimes fixes |

The generators *depend* on conventions: a missing `Produces(...)` or an inconsistent route breaks
the generated client. The rules *enforce* those conventions. Generation without rules was fragile.
Rules without generation were just nagging. Together they made each other useful.

The "JIT" in the names was about timing: the RuleJIT README talks about "Just In Time" analysis,
finding an issue right when it's introduced instead of in a review weeks later.

## Lessons that stuck

- **Parse once, generate many.** A good model of the solution (that became Solution.Parser) was
  worth more than any individual generator.
- **Generated code needs an automated bar.** "The generated solution builds" is cheap to check and
  catches most problems.
- **A CLI is a collection of habits.** Every command started as something I had done manually more
  than twice.
- **Rules are the part that scales.** A generator helps the person running it. A rule helps
  everyone who touches the repository afterwards, whoever or whatever writes the code.

What I'd do today: write fewer, sharper rules with much better failure messages, and decide early
which rules belong in a test and which belong in a Roslyn analyzer. That question is the core of
what came next: [self-defending codebases](/blog/2026-self-defending-codebases/).
