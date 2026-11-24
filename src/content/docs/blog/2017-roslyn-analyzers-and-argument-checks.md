---
title: Roslyn analyzers and argument checks without the performance cost
date: 2017-06-10
authors: rene
tags: [retrospective, roslyn, dotnet, performance]
excerpt: In 2017 I wrote my first Roslyn analyzer with a code fix, and started a long-running hunt for argument checks that report the parameter name without paying for it on every call. The hunt ended years later in a NuGet package.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2017. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

In spring 2017 two of my interests crossed: getting the compiler to enforce rules for me, and getting
rid of boilerplate without slowing anything down. They led to two small repositories. One is a Roslyn
analyzer sample with a code fix. The other is a set of experiments on how to write argument checks
that are short to type, still report the right parameter name, and cost (almost) nothing when the
argument is valid.

## An analyzer and its code fix

[RoslynAnalyzerAndFixture](https://github.com/RenePeuser/RoslynAnalyzerAndFixture) started from the
Visual Studio "Analyzer with Code Fix" template. I turned it into a localization rule: every string
literal is a candidate for translation. The repository even contains a small slide deck I used to
explain the structure. It's always the same two halves.

The **analyzer** describes a diagnostic and registers a callback for one syntax kind:

```csharp
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public class FindStringToLocalizeAnalyzer : DiagnosticAnalyzer
{
    public const string DiagnosticId = "FindStringToLocalize";

    private static readonly DiagnosticDescriptor Rule = new DiagnosticDescriptor(
        DiagnosticId,
        title: "Strings must be localized",
        messageFormat: "Please localize '{0}'",
        category: "Localization",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.StringLiteralExpression);
    }

    private static void AnalyzeNode(SyntaxNodeAnalysisContext context)
    {
        var node = (LiteralExpressionSyntax)context.Node;
        context.ReportDiagnostic(Diagnostic.Create(Rule, node.GetLocation(), node.ToString()));
    }
}
```

(The original messages were in German. I've translated them here.)

The **code fix provider** says which diagnostic IDs it can fix, finds the offending node and
registers a `CodeAction`:

```csharp
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(FindStringToLocalizeCodeFixProvider)), Shared]
public class FindStringToLocalizeCodeFixProvider : CodeFixProvider
{
    private const string Title = "Localize string";

    public sealed override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(FindStringToLocalizeAnalyzer.DiagnosticId);

    public sealed override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public sealed override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        var diagnostic = context.Diagnostics.First();

        // Walk up from the reported position to the literal that caused it.
        var literal = root.FindToken(diagnostic.Location.SourceSpan.Start).Parent
            .AncestorsAndSelf().OfType<LiteralExpressionSyntax>().First();

        context.RegisterCodeFix(
            CodeAction.Create(Title, ct => LocalizeString(context.Document, literal, ct), equivalenceKey: Title),
            diagnostic);
    }
}
```

The action itself builds a new syntax tree. This one wraps the literal in a
`new TranslatableText("...")`:

```csharp
private async Task<Document> LocalizeString(Document document, LiteralExpressionSyntax literal, CancellationToken ct)
{
    var root = await document.GetSyntaxRootAsync(ct);
    var currentNode = root.FindNode(literal.Span);

    var generator = SyntaxGenerator.GetGenerator(document);
    var typeName = SyntaxFactory.IdentifierName("ConsoleApp1.TranslatableText");
    var creation = generator.ObjectCreationExpression(typeName, SyntaxFactory.Argument(literal));

    var newRoot = generator.ReplaceNode(root, currentNode, creation);
    return document.WithSyntaxRoot(newRoot);
}
```

Exporting `WellKnownFixAllProviders.BatchFixer` gives you "Fix all in document/project/solution" for
free.

:::caution[Honest footnote]
It was a learning sample. The rule flags *every* literal, including log messages and keys. And the
unit test project still contains the template's default test for upper-case type names. The real
value for me was understanding the pipeline: syntax node, diagnostic, code action, new document.
That later fed into architecture tests built on Roslyn syntax trees.
:::

## The test I should have written

For this retrospective I put the analyzer and the code fix into a fresh test project, using today's
[`Microsoft.CodeAnalysis.Testing`](https://github.com/dotnet/roslyn-sdk) packages
(`Microsoft.CodeAnalysis.CSharp.CodeFix.Testing` with MSTest). This is 2026 code, not from the
archive. The `{|Id:...|}` markup marks where a diagnostic is expected, and the verifier checks the
diagnostic, applies the fix and compares the result:

```csharp
using Verify = Microsoft.CodeAnalysis.CSharp.Testing.CSharpCodeFixVerifier<
    FindStringToLocalizeAnalyzer,
    FindStringToLocalizeCodeFixProvider,
    Microsoft.CodeAnalysis.Testing.DefaultVerifier>;

[TestClass]
public class FindStringToLocalizeTests
{
    private const string TranslatableText = """
        namespace ConsoleApp1
        {
            public class TranslatableText
            {
                public TranslatableText(string text) { }
            }
        }

        """;

    [TestMethod]
    public async Task Literal_is_reported_and_wrapped_in_TranslatableText()
    {
        var source = TranslatableText + """
            class Greeter
            {
                object Greet() => {|FindStringToLocalize:"Hello"|};
            }
            """;

        var fixedSource = TranslatableText + """
            class Greeter
            {
                object Greet() => new ConsoleApp1.TranslatableText("Hello");
            }
            """;

        await Verify.VerifyCodeFixAsync(source, fixedSource);
    }

    [TestMethod]
    public async Task Literal_inside_TranslatableText_is_not_reported()
    {
        var source = TranslatableText + """
            class Greeter
            {
                object Greet() => new ConsoleApp1.TranslatableText("Hello");
            }
            """;

        await Verify.VerifyAnalyzerAsync(source);
    }
}
```

Running these tests against the 2017 code found three bugs within a few seconds:

1. **The fixed code is flagged again.** After the fix, `"Hello"` is still a string literal, so the
   analyzer reports it again and the fix wants to wrap it a second time. The second test fails.
2. **The fix builds an invalid syntax tree.** `IdentifierName("ConsoleApp1.TranslatableText")`
   creates *one* identifier token that contains a dot. It prints correctly, so I never noticed. But
   the verifier re-parses the result, expects a `QualifiedName` and reports the difference.
3. **`FindNode` picks the wrong node.** When a literal is the only thing inside an argument,
   `root.FindNode(literal.Span)` returns the `ArgumentSyntax`, because it has the same span. The
   2017 code then replaced an argument with an expression and crashed with an `InvalidCastException`.

The fixes are small. The analyzer skips literals that are already wrapped:

```csharp
private static void AnalyzeNode(SyntaxNodeAnalysisContext context)
{
    var node = (LiteralExpressionSyntax)context.Node;
    if (IsAlreadyTranslatable(node))
    {
        return;
    }

    context.ReportDiagnostic(Diagnostic.Create(Rule, node.GetLocation(), node.ToString()));
}

private static bool IsAlreadyTranslatable(LiteralExpressionSyntax node) =>
    node.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: ObjectCreationExpressionSyntax creation } }
    && creation.Type.ToString().EndsWith("TranslatableText", StringComparison.Ordinal);
```

The code fix parses the type name and replaces the literal it already found, without a second
lookup:

```csharp
var typeName = SyntaxFactory.ParseTypeName("ConsoleApp1.TranslatableText");   // a real QualifiedName
var creation = generator.ObjectCreationExpression(typeName, SyntaxFactory.Argument(literal));
var newRoot = generator.ReplaceNode(root, literal, creation);
```

After these changes, both tests pass. A comparison by type name is still a shortcut. A real rule
would ask the `SemanticModel` for the symbol. But the lesson is clear: an analyzer without tests is
a guess.

## Shipping it: package and severity

In 2017 the template's `.nuspec` already used the convention that still applies today. Analyzer
DLLs go into `analyzers/dotnet/cs`, and the package is marked as a `developmentDependency`, so it
does not become a runtime reference for consumers. Today the SDK project does the same thing without
a `.nuspec` (again, 2026 code):

```xml
<PropertyGroup>
  <TargetFramework>netstandard2.0</TargetFramework>
  <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  <IncludeBuildOutput>false</IncludeBuildOutput>
  <DevelopmentDependency>true</DevelopmentDependency>
</PropertyGroup>

<ItemGroup>
  <None Include="$(OutputPath)\$(AssemblyName).dll" Pack="true" PackagePath="analyzers/dotnet/cs" Visible="false" />
</ItemGroup>
```

Analyzers still target `netstandard2.0`, because they run inside the compiler, in Visual Studio and
in `dotnet build`. Within a single solution you don't need a package at all. A project reference
with `OutputItemType="Analyzer"` is enough:

```xml
<ProjectReference Include="..\FindStringToLocalize\FindStringToLocalize.csproj"
                  OutputItemType="Analyzer" ReferenceOutputAssembly="false" />
```

Consumers decide how strict a rule is in `.editorconfig`. That gives the team control over the rule
without changing the analyzer:

```ini
[*.cs]
# breaks the build
dotnet_diagnostic.FindStringToLocalize.severity = error

[**/Logging/**.cs]
# log messages are not UI text
dotnet_diagnostic.FindStringToLocalize.severity = none
```

The second block answers the "honest footnote" above in a cheap way: if a rule is too broad, you
can scope it by path before you invest in a smarter analyzer.

## The argument-check problem

The classic guard clause is fast and boring:

```csharp
if (name == null)
{
    throw new ArgumentNullException(nameof(name));
}
```

Four lines per argument, and before `nameof` people passed string literals that silently went out of
date. The popular alternative back then was `Expression<Func<T>>`: `Check.NotNull(() => name)`. It
reads nicely and gives you the name for free, but you pay for it on **every** call, even when the
argument is fine.

[SuperFastArgumentCheck](https://github.com/RenePeuser/SuperFastArgumentCheck) (later restructured
as [ArgumentChecking](https://github.com/RenePeuser/ArgumentChecking)) is my comparison of the
options. Its description says it all: *check arguments without expressions, so you don't lose any
performance in production code*. The speed test builds 100,000 instances of a tiny class per variant:

- **Standard:** the hand-written `if`/`throw` as the baseline.
- **Expression with `Compile()`:** compile the lambda, invoke it, read the member name.
- **Expression without compile:** cast the body to `MemberExpression`, read the captured field via reflection.
- **Anonymous type:** `Expect.NotNullAnonym(new { name })`, then read the first property name.
- **Stack trace:** `name.NotNullOneParam()` with `[MethodImpl(NoInlining)]`, using `StackTrace` to find the caller's parameter.
- **`Func<T>`:** `Expect.NotNull(() => name)`.

## Why `Func<T>` wins: pay only when it fails

The trick is *lazy evaluation of the expensive part*. A `Func<T>` lambda that captures a parameter
makes the C# compiler generate a closure class with a field named exactly like the parameter. In the
happy path we just invoke the delegate and compare with `null`. Only when the check **fails** do we
use reflection on `func.Target` to find out what the argument was called:

```csharp
public static T NotNull<T>(Func<T> func)
{
    var value = func();
    if (value == null)
    {
        // Only on failure: inspect the compiler-generated closure for the field name.
        var fields = func.Target.GetType().GetFields(
            BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        var fieldInfo = fields.FirstOrDefault(f => f.GetValue(func.Target) == null);
        throw new ArgumentNullException(fieldInfo.Name);
    }

    return value;
}
```

Compare that with the expression version, which has to do its work up front:

```csharp
private static void IsNull(Expression<Func<object>> argumentExpression)
{
    var compiled = argumentExpression.Compile();   // paid on every call
    if (compiled() == null)
    {
        var member = (MemberExpression)argumentExpression.Body;
        throw new ArgumentNullException(member.Member.Name);
    }
}
```

The stack-trace variant is the most elegant to type (`Name = name.NotNullOneParam();`). But it
depends on optimization settings: the code even throws *"Check code optimization settings, no
parameter info is existing"* when the frame can't be resolved. Too fragile for production.

:::note
The repository contains the speed tests, but no recorded results. Back then I read the timings from
the Visual Studio test runner. I won't make up numbers now. The *structure* of the argument still
holds: a closure allocation and a delegate call are cheap, and `Expression.Compile()` on every call
is not.
:::

I also wrote a custom `ExpectedArgumentException` test attribute that checks not just the exception
type but the **parameter name**. If the name is what you're optimizing for, it should be what you
assert on.

## Where it went: Argument.Check

The experiments didn't stay experiments. In December 2019 I started
[Argument.Check](https://github.com/RenePeuser/Argument.Check), built on the `Func<T>` idea:

```csharp
[DebuggerHidden]
private static void IfNullInternal<T>(Func<T> argumentFunc) where T : class
{
    if (argumentFunc() != null)
    {
        return;
    }

    throw new ArgumentNullException(argumentFunc.GetParameterName(arg => arg == null));
}
```

Multiple checks on the same argument made the closure lookup ambiguous. So a later helper,
`ILMethodToFieldRebuilder`, reconstructs which compiler-generated lambda belongs to which captured
field. That's quite deep into implementation details of the C# compiler.

Then the language gave me a real feature for it. A commit from December 2020 reads *"prepare all to use the new caller
argument expression attribute, hopefully it works soon"*. With C# 10, `CallerArgumentExpression`
made all the closure reflection unnecessary:

```csharp
public static T IfNull<T>([NotNull] T? argument,
                          [CallerArgumentExpression(nameof(argument))] string argumentName = "")
    where T : class
{
    if (argument is null)
    {
        throw new ArgumentNullException(argumentName);
    }

    return argument;
}
```

No delegate, no allocation, no reflection, and the call site is just `Throw.IfNull(service)`.

At the call site, a typical constructor shrinks from this:

```csharp
public OrderService(IOrderRepository repository, string region, int maxItems)
{
    if (repository == null)
    {
        throw new ArgumentNullException(nameof(repository));
    }

    if (string.IsNullOrWhiteSpace(region))
    {
        throw new ArgumentException("Region must not be empty.", nameof(region));
    }

    if (maxItems < 1 || maxItems > 100)
    {
        throw new ArgumentOutOfRangeException(nameof(maxItems));
    }

    _repository = repository;
    _region = region;
    _maxItems = maxItems;
}
```

to this, because every helper returns the checked value:

```csharp
public OrderService(IOrderRepository repository, string region, int maxItems)
{
    _repository = Throw.IfNull(repository);
    _region = Throw.IfNullOrWhiteSpace(region);
    _maxItems = Throw.IfOutOfRange(maxItems, 1, 100);
}
```

The exceptions are standard .NET exceptions, with the parameter name taken from the call site:

```text
ArgumentNullException:       Value cannot be null. (Parameter 'repository')
ArgumentOutOfRangeException: Value: '150' is not in expected range from '1' to '100'. (Parameter 'maxItems')
```

`CallerArgumentExpression` captures the *expression*, not just a name. `Throw.IfNull(order.Customer)`
reports `(Parameter 'order.Customer')`, which is often more useful in a log than the bare parameter.

The tests assert exactly that. The `ExpectedArgumentException` idea from 2017 survived, now with
plain MSTest:

```csharp
[TestMethod]
public void Should_Throw_An_Exception_With_Correct_Exception_Message_If_Argument_Is_Null()
{
    var exception = Assert.ThrowsExactly<ArgumentNullException>(() => TestMethod(_nullString));

    Assert.AreEqual("Value cannot be null. (Parameter 'argument')", exception.Message);
}
```

The
repository now has a BenchmarkDotNet project that compares each helper against a hand-written null
check and a throw expression. The package is on
[NuGet](https://www.nuget.org/packages/Argument.Check/) and had about 1.12 million downloads as of
July 2026, according to my [NuGet profile](https://www.nuget.org/profiles/Rene.Peuser).

## Lessons that stuck

- **Measure the happy path.** Guard clauses run millions of times and almost never fail. Make the
  common case cheap and let the rare case be slow.
- **Clever tricks have a half-life.** Closure-field reflection and IL reconstruction worked, but they
  depended on compiler internals. When the language offered a real feature, I deleted the cleverness
  happily.
- **Analyzers are about the pipeline, not the rule.** Once you understand diagnostic, location and
  code action, writing the *right* rule becomes the hard and interesting part.

What I'd do today: start with `CallerArgumentExpression` and `ArgumentNullException.ThrowIfNull`
where they're enough, add a library only for richer checks, and keep BenchmarkDotNet results in the
repository from day one, so a retrospective like this one can quote numbers instead of
explaining why it can't.
