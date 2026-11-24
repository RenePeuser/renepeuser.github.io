---
title: Reading code like code — statements, types and symbols in Solution.Parser
date: 2026-11-24
authors: rene
tags: [dotnet, solution-parser, code-rules, roslyn, linq]
excerpt: Most code rules start with a string search and end with false positives. Solution.Parser's model lets a rule walk the code the way you read it, the method, the loop in it, the call in the loop, with types taken apart and, when the syntax isn't enough, the compiler's answer to "which method is this really?".
---


The first version of almost every homegrown code rule is a text search. `grep "new HttpClient"`.
`Contains("Thread.Sleep")`. It works for a week. Then someone writes `using static
System.Threading.Thread;` and calls `Sleep(100)`, the rule misses it, and someone else names a method
`ValidateNewHttpClientOptions` and the rule flags it.

Text doesn't know what code means. A syntax tree knows the shape. The compiler knows the meaning.
[Solution.Parser](https://github.com/RenePeuser/Solution.Parser) gives a rule both, behind one model
that reads like the code itself. This post is a tour through that model, with the rules it makes easy.
If you haven't set up a rule suite yet, start with
[the first post of this series](/blog/2026-solution-parser-your-solution-as-a-queryable-model/).

## Walk the code the way you read it

One file is one `CSharpSyntaxTree`. A rule walks it the way you'd read the file: its classes, their
methods, the loops in them:

```csharp
var tree = CSharpSyntaxTree.Parse(@"D:\repo\src\Order.cs");

from @class in tree.Classes          // every class of the file, nested ones included
from method in @class.Methods        // the methods of this class
from loop in method.Loops            // the loops of this method
from inner in loop.Loops             // the loops inside this loop
select inner.Location;
```

The important design decision: **a statement answers the same questions as its method**, only for the
code it spans. A loop has `Invocations`, `Awaits`, `Loops` and `ObjectCreations`, just like the method
around it. That makes rules about *where* something happens trivial to write:

```csharp
// No save inside a loop
from member in trees.MembersWithBody
from loop in member.Loops
from call in loop.Invocations
where call.Name is "SaveChanges" or "SaveChangesAsync"
select $"{call.Location}: {member.Name} calls {call.Name} once per item, save after the loop";

// No await inside a foreach: start the tasks and await them together
from member in trees.MembersWithBody
from loop in member.ForEachLoops
from awaited in loop.Awaits
select $"{awaited.Location}: {member.Name} awaits one at a time, start the tasks and await Task.WhenAll";
```

Try writing the first one with a text search. You'd need to know where a loop starts and ends, which
braces belong to it, and whether the call sits in a lambda inside the loop. Here it's three `from`s.

`MembersWithBody` is worth knowing: it's every body in the code. Methods, constructors, operators,
local functions, and the accessors of properties, indexers and events. A call hidden in
`get { return Load(); }` is found, which older versions of the library missed.

## Typed statements instead of text

Statements are typed, so a rule can pattern match on what the code *is*:

```csharp
method.TryStatements                       // Block, Catches, Finally, HasCatch, HasFinally
tryStatement.Catches                       // ExceptionType, Filter, IsEmpty, CatchesAnyException, IsRethrowing, IsThrowing
method.SwitchExpressions                   // Arms with Pattern, WhenClause, Result; HasDiscardArm
method.IfStatements / Returns / Throws / UsingStatements / LockStatements
ifStatement.ElseCount / ElseIfs / IsElseIf // the else-if chain, counted once from its first if
statement.EndsWithJump                     // ends in return, throw, break, continue or goto
```

That turns review comments into rules almost word for word:

```csharp
// throw; keeps the stack trace, throw ex; does not
from member in trees.MembersWithBody
from tryStatement in member.TryStatements
from @catch in tryStatement.Catches
from throwStatement in @catch.Throws
where @catch.VariableName is not null && throwStatement.Value?.Name == @catch.VariableName
select $"{throwStatement.Location}: {throwStatement.SourceCode} loses the stack trace, write throw;";

// The catch neither throws nor logs
from member in trees.MembersWithBody
from tryStatement in member.TryStatements
from @catch in tryStatement.Catches
where @catch.CatchesAnyException && !@catch.IsThrowing && !@catch.Invocations.Any(i => i.Name == "LogError")
select $"{@catch.Location}: the catch neither throws nor logs";

// No else after a branch that returns, throws, breaks or continues
from member in trees.MembersWithBody
from statement in member.IfStatements
where statement.HasElse && statement.Then.EndsWithJump
select $"{statement.Location}: the if in {member.Name} returns, drop the else and go on after it";
```

A catch is reached the way the code reads: the method, its `try`, its catches. It's not a free-floating
statement you have to match back to its `try` by line numbers.

## Expressions and patterns are trees

Below statements, expressions are trees too. A binary expression has `Left`, `Right` and `Operator`, a
call has `Name`, `Target` and `Arguments`, `x is ...` has a `Pattern`. `method.AllExpressions` is every
expression of a body at any depth:

```csharp
// Null checks read as null checks: x is null, x is not null
from member in trees.MembersWithBody
from expression in member.AllExpressions
where (expression.Operator is "==" or "!=" && expression.Right?.Kind == ExpressionKind.NullLiteral)
   || expression.Pattern is { Kind: PatternKind.Recursive, IsNotNull: true }
select $"{expression.Location}: write {expression.SourceCode} as is null or is not null";

// Structured logging: a template, not an interpolated string
from call in trees.Invocations
where call.Name.StartsWith("Log", StringComparison.Ordinal)
   && call.Arguments.Any(a => a.Kind == ExpressionKind.InterpolatedString)
select $"{call.Location}: {call.Name} with an interpolated string loses the structure, pass a template";
```

The second rule catches one of the most common logging mistakes I see in reviews,
`logger.LogInformation($"Order {id} placed")`, which throws away the structured properties your log
backend could index. `ExpressionKind` tells a string literal from an interpolated string, a `nameof`, a
`typeof` or a lambda, so the rule doesn't have to guess from the text.

Fluent calls are linked as chains, which makes rules about minimal API setup possible:

```csharp
// Every minimal API endpoint requires authorization
from method in trees.Methods
from chain in method.InvocationChains
where chain.Contains("MapGet") && !chain.After("MapGet").Any(c => c.Name == "RequireAuthorization")
select $"{chain.Location}: {chain.First.Arguments[0].StringValue} is not protected";
```

`StringValue` is the literal without quotes, so the finding names the route: *"api/orders is not
protected"*.

## Types, taken apart

Every type written in a declaration is parsed into a `TypeReference`, so a rule no longer cuts
`Task<List<Foo>>` at `<` and `>` by hand:

```csharp
field.TypeReference.Is("ILogger")                    // matches ILogger<MyService> as well
method.ReturnType.UnwrapTask().IsCollection          // Task<List<Foo>> -> true
method.ReturnType.UnwrapTask().ElementType?.Name     // "Foo"
parameter.TypeReference.Mentions("DateTime")         // anywhere inside, List<DateTime?> included
creation.TypeReference.Is<HttpClient>()              // from a real type: namespace checked
@catch.ExceptionType.Is<OperationCanceledException>()
```

Collections are classified for you. A type is exactly one of `IsImmutableCollection` (`ImmutableList`,
`FrozenSet`, …), `IsReadOnlyCollection` (`IReadOnlyList`, `IEnumerable`, …) or `IsMutableCollection`
(`List`, arrays, `Dictionary`, …). That's the rule I wanted for years for DTOs and records:

```csharp
// Records hold no mutable collections, positional properties included
from record in trees.Records
from property in record.Properties
where property.TypeReference.IsMutableCollection
select $"{property.Location}: {record.Name}.{property.Name} is a {property.TypeReference.Name}, use an immutable collection";
```

`IsImmutable` goes all the way down: `ImmutableList<string>` is immutable, `ImmutableList<List<int>>`
isn't. Your own types are unknown to the syntax, so `IsImmutableWith` lets you say which ones count:

```csharp
var immutableRecords = trees.Records.Select(r => r.Name).ToHashSet();

from type in trees.Records
from property in type.Properties
where !property.TypeReference.IsImmutableWith(t => immutableRecords.Contains(t.Name))
select $"{property.Location}: {type.Name}.{property.Name} can change";
```

## When the syntax isn't enough: symbols

Back to the opening example. The syntax sees `Sleep(100)` and can't tell whose `Sleep` it is. With
`ParseMode.WithSymbols`, Solution.Parser builds a Roslyn compilation per project, on first use, and the
same records start answering semantic questions:

```csharp
var solution = SolutionFile.Find("MySolution.sln", ParseMode.WithSymbols);

// No Thread.Sleep, however it is written
var findings = from call in solution.ProductionTrees.Invocations
               where call.Method?.FullyQualifiedName == "System.Threading.Thread.Sleep"
               select $"{call.Location}: Thread.Sleep blocks a thread, await Task.Delay instead";
```

This finds `Thread.Sleep(100)` and `Sleep(100)` through `using static`, and it doesn't flag your own
`Bed.Sleep(string reason)`. The README sample runs as a test against exactly that code.

Symbols also answer the question that's impossible from syntax alone: **which parameter does an
argument fill?** Take a test helper with a boolean flag:

```csharp
await Client.AssertPostAsync("api/orders", "create-order.json", true);
```

Is `true` the `writeResponse` flag? Only the compiler knows, especially when the method comes from a
NuGet package. With symbols, a rule can ask directly:

```csharp
from call in solution.UnitTestTrees.Invocations.Named("AssertPostAsync")
where call.Passes("writeResponse", true)
select $"{call.Location}: writeResponse is true, the test would overwrite its expected file";
```

`Passes` works whether the argument is written by position, by name, or left out and filled by a
default value. Underneath, a resolved call carries the full picture:

```csharp
call.Resolution            // Resolved | Ambiguous | Unresolved
call.Method                // a Method record; for code of the solution the very record the tree holds
call.Method.Origin         // Source | Package("AspNetCore.Simple.MsTest.Sdk", "9.5.15") | Framework
call.BoundArguments        // every parameter with what is passed for it, in parameter order
call.ArgumentFor("writeResponse").IsExplicit    // false when left out and the default applies
call.Roslyn                // node, semantic model, symbol and operation, for anything not covered
```

`Origin` is a nice one for dependency rules: *the domain layer doesn't call anything that comes from
the package `Microsoft.EntityFrameworkCore`*, checked per call instead of per `using`.

### The cost stays visible

Symbols aren't free: building compilations takes time and needs a restored solution, which it is
whenever its tests run. Solution.Parser makes that cost explicit:

| | `ParseMode.SyntaxOnly` | `ParseMode.WithSymbols` |
|---|---|---|
| What it builds | syntax trees, once, cached | plus one Roslyn compilation per project, on first use |
| Speed | fast | slower, paid only by rules that ask for symbols |
| Needs a restore | no | yes, it reads `obj/project.assets.json` |
| `call.Method` | throws instead of guessing | the resolved method |
| Typical rules | naming, structure, statements, layering | "which method is this", parameters, origins |

With `SyntaxOnly`, a symbol access **throws instead of guessing**. That's deliberate: a rule that
silently returns `null` for every call would pass and prove nothing. `project.CompilationDiagnostics()`
shows what the compiler couldn't resolve, so a rule can also assert that the compilation is complete.

## Small things that make rules honest

A few details that only matter once you have a real rule suite:

- **Partial classes.** A `partial` class is in `Classes` once per file. For a rule about the class as
  a whole, `trees.WholeTypes` joins the parts: `where type.Methods.Count > 20` counts across files.
- **Syntax errors.** `tree.Diagnostics` surfaces what Roslyn reported while parsing, so a rule can
  assert that no file is broken instead of trusting an incomplete model.
- **Suppressions.** `tree.PragmaWarnings` lists every `#pragma warning disable`, with its ids and the
  comment on its line. *No suppression without a reason* becomes a rule:

```csharp
from pragma in solution.ProductionTrees.PragmaWarnings
where pragma.Action == PragmaWarningAction.Disable
where string.IsNullOrWhiteSpace(pragma.Comment)
select $"{pragma.Location}: suppression without a reason";
```

- **Attributes by name or type.** `HasAttribute("Obsolete")` matches `[Obsolete]`,
  `[ObsoleteAttribute]` and `[System.ObsoleteAttribute]`. If the rule project can reference the type,
  `HasAttribute<ObsoleteAttribute>()` avoids the magic string.

## Pitfalls

- **Matching by name means matching by name.** Syntax-only `Is("List")` also matches a class of your
  own named `List`. If that matters, switch the rule to symbols.
- **Reaching for symbols too early.** Most rules are about structure and naming. Start syntax-only and
  move a rule to symbols when it produces a false positive the syntax can't avoid.
- **Forgetting lambdas and local functions.** The lists on a member include what sits in lambdas and
  leave local functions to themselves, because a local function is a member with its own body. A rule
  that iterates `MembersWithBody` sees both.
- **Upgrading and seeing more findings.** Version 7 lets rules see accessor bodies, extension blocks
  and positional record properties. More findings after an upgrade is code the rules were blind to,
  not a regression. The [MIGRATION.md](https://github.com/RenePeuser/Solution.Parser/blob/main/MIGRATION.md)
  is written so you can hand it to an AI assistant together with your rule suite.

## Summary

- A rule walks the code the way you read it: method, loop, call. Every statement answers the same
  questions as its method.
- Statements, expressions and patterns are typed trees, so rules pattern match instead of searching
  text.
- `TypeReference` takes types apart and classifies collections as immutable, read-only or mutable.
- `ParseMode.WithSymbols` adds the compiler's answers (which method, which parameter, which package)
  over the same records, and the cost stays visible because syntax-only mode throws instead of
  guessing.

The [next post](/blog/2026-solution-parser-architecture-tests-for-projects-and-xaml/) moves up a level:
project layering, namespace boundaries and rules that check XAML against the C# behind it.
