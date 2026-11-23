---
title: Building .NET tools — from a script in the wiki to dotnet tool install
date: 2026-11-23
authors: rene
tags: [dotnet, tooling, nuget]
excerpt: Every team has a folder of PowerShell scripts and a wiki page explaining which one to run when. .NET tools turn that into versioned, installable, testable CLIs distributed through NuGet. How to build one with System.CommandLine, global vs. local tools, and the details that make a tool pleasant instead of painful.
---


Most teams I work with have a `scripts/` folder. Something to seed a database, something to call an internal
API with the right token, something to regenerate clients. Next to it there's a wiki page that explains which
script to run, which PowerShell version it needs and which environment variables have to be set first. Half
the team uses an outdated copy from their desktop.

.NET tools are the cure for that. A tool is a console app packaged as a NuGet package. You install it with
one command, update it with another, it runs on Windows, macOS and Linux, and it's versioned like every other
package. And because it's C#, it can share code, typed clients and tests with the rest of your solution.

## What a .NET tool is

A .NET tool is a NuGet package with a special flag. `dotnet tool install` downloads it, puts the binaries into a
tools folder and creates a shim with the command name on your `PATH`. There are three ways to run one:

| | Global tool | Local tool | One-shot (`dnx`, .NET 10+) |
|---|---|---|---|
| Install | `dotnet tool install -g` | `dotnet tool install` + manifest | none, runs directly |
| Scope | the user, all folders | the repository | a single invocation |
| Version pinned in the repo | ❌ | ✅ `.config/dotnet-tools.json` | on the command line |
| Typical use | personal productivity tools | build, codegen, formatting tools for a repo | trying a tool, CI one-liners |

For anything a repository depends on (code generators, linters, migration tools), I strongly prefer **local
tools**. The manifest is committed, `dotnet tool restore` installs exactly those versions, and the build agent
and every developer run the same thing. Global tools are for things that are about *you*, not about a repo.

## Setting up the project

Start with a normal console app and add three properties:

```xml
<!-- src/MyShop.Cli/MyShop.Cli.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>

    <PackAsTool>true</PackAsTool>
    <ToolCommandName>myshop</ToolCommandName>
    <PackageId>MyShop.Cli</PackageId>

    <!-- run on newer runtimes too; see pitfalls -->
    <RollForward>Major</RollForward>

    <Description>Command-line tool for the MyShop platform: orders, catalog and local dev environment.</Description>
    <PackageReadmeFile>README.md</PackageReadmeFile>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="System.CommandLine" />
    <PackageReference Include="Microsoft.Extensions.Http.Resilience" />
    <None Include="README.md" Pack="true" PackagePath="\" />
  </ItemGroup>
</Project>
```

`PackAsTool` makes `dotnet pack` produce a tool package, `ToolCommandName` is what users type. Everything from
the [post about NuGet packages](/blog/2026-creating-nuget-packages/) applies here too: description, readme,
versions from [GitVersion](/blog/2026-versioning-with-gitversion/), publishing only from the pipeline.

## Commands with System.CommandLine

You can parse `args` by hand. You shouldn't. `System.CommandLine` gives you subcommands, typed options,
validation, `--help` and tab completion for free. A tool with one command group:

```csharp
using System.CommandLine;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.example.com/"))
        .AddStandardResilienceHandler();
services.AddSingleton<GetOrderCommand>();
await using var provider = services.BuildServiceProvider();

var root = new RootCommand("Command-line tool for the MyShop platform.");
root.Subcommands.Add(BuildOrdersCommand(provider));

return await root.Parse(args).InvokeAsync();

static Command BuildOrdersCommand(IServiceProvider provider)
{
    var idOption = new Option<int>("--id") { Description = "Order ID.", Required = true };
    var jsonOption = new Option<bool>("--json") { Description = "Print raw JSON instead of a summary." };

    var get = new Command("get", "Show a single order.") { idOption, jsonOption };
    get.SetAction((parseResult, ct) =>
        provider.GetRequiredService<GetOrderCommand>()
                .RunAsync(parseResult.GetValue(idOption), parseResult.GetValue(jsonOption), ct));

    return new Command("orders", "Work with orders.") { get };
}
```

```csharp
public sealed class GetOrderCommand(OrdersClient orders, TextWriter? output = null)
{
    private readonly TextWriter _out = output ?? Console.Out;

    public async Task<int> RunAsync(int id, bool json, CancellationToken ct)
    {
        var order = await orders.GetAsync(id, ct);
        if (order is null)
        {
            await Console.Error.WriteLineAsync($"Order {id} not found.");
            return ExitCodes.NotFound;
        }

        await _out.WriteLineAsync(json
            ? JsonSerializer.Serialize(order)
            : $"{order.Id}  {order.Status,-10}  {order.Total:C}");
        return ExitCodes.Success;
    }
}

public static class ExitCodes
{
    public const int Success = 0;
    public const int NotFound = 2;
}
```

The result is `myshop orders get --id 42`, with help text and validation:

```
$ myshop orders get
Option '--id' is required.

Description:
  Show a single order.

Usage:
  myshop orders get [options]
```

Notice the HttpClient setup: even a tool deserves `IHttpClientFactory` and a typed client. The
[HttpClient post](/blog/2026-httpclient-you-are-using-it-wrong/) explains why, and why a singleton command is fine
for a short-lived CLI run.

:::note[System.CommandLine 2.0]
System.CommandLine was in preview for years, and much of the sample code you'll find online uses the old beta API
(`SetHandler`, `AddOption`, `InvocationContext`). The stable 2.0 API looks like the code above: `SetAction`,
`Options`/`Subcommands` collections and `Parse(args).InvokeAsync()`. If you upgrade an older tool, expect some
mechanical changes.
:::

## Design rules for a pleasant CLI

A few rules make the difference between a tool people use and one they work around:

- **Exit codes mean something.** `0` for success, anything else for failure, documented. Scripts and pipelines
  depend on it.
- **Data to stdout, diagnostics to stderr.** Then `myshop orders get --id 42 --json | jq .status` works.
- **A machine-readable mode.** `--json` (or `--output json`) for anything that might be scripted.
- **No interactive prompts in non-interactive contexts.** Check `Console.IsInputRedirected` or offer
  `--yes`/`--no-input`, otherwise the tool hangs in CI.
- **Honour cancellation.** Ctrl+C should stop the HTTP call, not leave the process hanging. The `CancellationToken`
  passed to `SetAction` handles that.
- **Credentials from the environment or a credential provider**, never as a command-line argument that ends up
  in the shell history.

## Generating tools instead of writing them

If your tool is mostly "call endpoint X of our API with these parameters", consider generating it from the API
itself. One approach I've used maps every controller or minimal API group to a command, the API version to a
subcommand, and the request to a JSON payload. The generator analyzes the API with Roslyn, so the CLI stays in sync
whenever the API changes. I wrote about that in the
[ClientGenerator and RunJit retrospective](/blog/2024-clientgenerator-runjit-rulejit/).

## Pitfalls

**The tool doesn't start on a newer runtime.** A tool built for `net8.0` won't run on a machine that only has
.NET 10 installed, because framework-dependent apps only roll forward within a major version by default.
`<RollForward>Major</RollForward>` lets it run on newer major versions. Alternatively, multi-target the tool. Since
the .NET 10 SDK you can also ship platform-specific or Native AOT tool packages that don't need a matching runtime
at all.

**Global tools drift.** Nobody runs `dotnet tool update -g` regularly. If the tool talks to an API that evolves,
check the version at startup and print a hint when a newer one is available. Or make it a local tool, where the
repository decides the version.

**Testing by installing.** Testing changes by running `dotnet tool install -g --add-source ./bin` over and over is
slow and leaves stale versions around. Use `dotnet run --project src/MyShop.Cli -- orders get --id 42` during
development, and only install in the pipeline (below).

**Private feeds and installs.** `dotnet tool install` respects `nuget.config`. For a tool on a private feed, make
sure developers have the feed configured with package source mapping, as described in the NuGet packages post.

## Test it and smoke-test the package

Keep the commands thin and put the logic into classes like `GetOrderCommand` above. Those are easy to unit-test with
a fake `HttpMessageHandler` and a `StringWriter` for the output:

```csharp
[TestMethod]
public async Task Prints_summary_for_existing_order()
{
    var output = new StringWriter();
    var command = new GetOrderCommand(FakeOrdersClient.With(new Order(42, "Shipped", 99.90m)), output);

    var exitCode = await command.RunAsync(42, json: false, CancellationToken.None);

    Assert.AreEqual(ExitCodes.Success, exitCode);
    StringAssert.Contains(output.ToString(), "Shipped");
}
```

And in the pipeline, install the freshly packed tool into a temporary folder and run it once. That catches a broken
`ToolCommandName`, missing dependencies and runtime roll-forward problems before anyone else sees them:

```bash
dotnet pack src/MyShop.Cli -c Release -o artifacts
dotnet tool install MyShop.Cli --tool-path ./.tools --add-source ./artifacts --prerelease
./.tools/myshop --help
```

## Summary

- A .NET tool is a **console app packaged as NuGet**: installable, updatable, versioned and cross-platform.
- Prefer **local tools with a manifest** for anything a repository depends on; global tools for personal use.
- Set **`PackAsTool`**, **`ToolCommandName`** and **`RollForward`**, and treat the tool like any other package.
- Use **System.CommandLine 2.0** for commands, options, help and validation, and DI with typed HttpClients.
- Design for scripting: **meaningful exit codes, stdout vs. stderr, a JSON mode, no prompts in CI**.
- **Unit-test** the command logic and **smoke-test** the installed package in the pipeline.
