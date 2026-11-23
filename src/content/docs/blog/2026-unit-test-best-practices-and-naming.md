---
title: Unit tests that explain themselves — structure and naming
date: 2026-11-23
authors: rene
tags: [testing, dotnet, code-quality]
excerpt: A test called CalculateSomething with five asserts tells you one thing when it fails, and you have to run it five times to learn the rest. Naming conventions, test class structure and assertion habits that make a failing unit test explain itself.
---

:::note[Series]
Part of the series [*Testing in practice*](/series/testing-in-practice/).
:::

I can usually tell how a team feels about its unit tests by reading the test explorer, without opening
a single file. `Test1`, `CalculateTest`, `PriceCalculatorTests.Works`, `Bug4711`. When test names look
like that, nobody reads the tests, and nobody trusts them either. They're a gate you have to get
through, not documentation you'd ever look at.

This post collects the habits that changed that in the teams I've worked with: how to name tests, how
to structure test classes, and how to assert so that a red test tells you what's wrong on the first
run.

## The problem: a test that tells you one thing at a time

```csharp
[TestClass]
public class PriceCalculatorTests
{
    [TestMethod]
    public void Calculate()
    {
        var result = new PriceCalculator().Calculate(TestData.OrderWithThreeLines);

        Assert.AreEqual(120.00m, result.Net);
        Assert.AreEqual(22.80m, result.Tax);
        Assert.AreEqual(142.80m, result.Gross);
        Assert.AreEqual(10.00m, result.Discount);
        Assert.AreEqual("EUR", result.Currency);
    }
}
```

When this fails, you see `Assert.AreEqual failed. Expected:<120.00>. Actual:<108.00>.` and nothing else.
Is the tax wrong too? The discount? You fix the net amount, run again, and find out the tax was also
wrong. In the worst case you need five runs to learn what one run could have told you.

And the name `Calculate` says nothing about which behaviour is being verified. When it turns red in
the pipeline, the first step is opening the file.

## Naming: the test name is the first line of the failure report

The convention I use, and the one that's survived several teams:

- **Test class:** `[Subject]_Tests`, for example `PriceCalculator_Tests`.
- **Test method:** `Should_[Expected_Behaviour]_When_[Condition]`, for example
  `Should_Apply_Volume_Discount_When_Quantity_Exceeds_Ten`.

The point is what you get when you put both together, which is exactly what test reports and
pipeline logs show:

```text
PriceCalculator_Tests.Should_Apply_Volume_Discount_When_Quantity_Exceeds_Ten
PriceCalculator_Tests.Should_Round_Tax_Per_Line_When_Tenant_Uses_Line_Rounding
OrderValidator_Tests.Should_Reject_Order_When_Shipping_Country_Is_Embargoed
```

You can read a failing pipeline like a list of broken promises, without opening any file.

A few rules of thumb that go with it:

- **Start with `Should`.** It forces you to state an expected behaviour, not a method name.
- **The `When` part is optional** if there's only one condition worth mentioning:
  `Should_Return_Empty_Result_For_Empty_Order` is fine.
- **Underscores between words.** `Should_Apply_Volume_Discount` scans much faster in a long list than
  `ShouldApplyVolumeDiscount`.
- **No ticket numbers in names.** `Bug4711` means something for two weeks. Describe the behaviour the
  bug violated instead.

### `_Tests` suffix or not?

There's a reasonable argument for dropping the suffix: `PriceCalculator.Should_Apply_Volume_Discount`
reads just as well.

| Class name | Combined with method | Readability | Risk |
|---|---|---|---|
| `PriceCalculator_Tests` | `PriceCalculator_Tests Should_Apply_Volume_Discount` | Very clear | None |
| `PriceCalculatorTests` | `PriceCalculatorTests Should_Apply_Volume_Discount` | Clear | None |
| `PriceCalculator` | `PriceCalculator Should_Apply_Volume_Discount` | Clear | Same name as the production class: confusing in search and in "go to type" |

In small projects I don't mind either way. In large solutions I keep the suffix, because "go to type"
showing two `PriceCalculator` classes costs everyone a few seconds, many times a day.

## Structure: split by the dimension that varies

The second habit is about test *classes*. The intuitive structure is one test class per production
class. That works until the production class has a few methods that each need twenty tests.

Here's an example from a data access helper I once had to test. Four overloads, each one a different
way of passing SQL parameters:

```csharp
public interface ISqlExecutor
{
    Task<long> ExecuteAsync(string sql, CancellationToken ct);
    Task<long> ExecuteAsync(string sql, IReadOnlyDictionary<string, object?> parameters, CancellationToken ct);
    Task<long> ExecuteAsync(string sql, object typedParameters, CancellationToken ct);
    Task<long> ExecuteAsync(string sql, DbParameterCollection parameters, CancellationToken ct);
}
```

"Four methods, one test class, done quickly." In practice, each overload needed tests for invalid SQL,
`null` values, type conversion, missing parameters, and so on. The result was one huge
`SqlExecutor_Tests` class where tests for different overloads were mixed, and nobody could tell
whether the dictionary overload handled `null` correctly without reading all of it.

The fix was to find the **dimension that actually varies**, here the parameter style, and give each
value its own class:

```text
SqlExecution/
  ExecuteAsync_Without_Parameters_Tests
  ExecuteAsync_With_Dictionary_Parameters_Tests
  ExecuteAsync_With_Typed_Parameters_Tests
  ExecuteAsync_With_DbParameters_Tests
```

```text
ExecuteAsync_With_Dictionary_Parameters_Tests.Should_Insert_Null_When_Value_Is_Null
ExecuteAsync_With_Dictionary_Parameters_Tests.Should_Throw_When_Parameter_Is_Missing_In_Sql
```

Now the test tree answers questions by itself: *which overload has a null test? Where do I add the
test for the bug in typed parameters?* It also makes gaps visible: if one class has twelve tests and
another has two, you know where to look.

The dimension is different every time. Sometimes it's the method, sometimes the input type, sometimes
the business rule (`PriceCalculator_Discount_Tests`, `PriceCalculator_Tax_Tests`). Pick the one that
tells you where to go when you need to add a test. And mirror the production namespaces, so
`MyShop.Pricing.PriceCalculator` has its tests in `MyShop.Pricing.Tests`.

## Arrange, act, assert, and one logical assertion

Inside a test I follow Arrange-Act-Assert, with a blank line between the three parts and no comment
headers once the team is used to it. More important is the assert part: **one test, one behaviour,
one logical assertion.**

"One logical assertion" doesn't mean one `Assert` call. It means comparing the *whole result* with the
*whole expectation*, so a failure shows every difference at once:

```csharp
[TestMethod]
public void Should_Apply_Volume_Discount_When_Quantity_Exceeds_Ten()
{
    var order = OrderBuilder.WithLine("MUG-01", quantity: 12, unitPrice: 10.00m).Build();

    var result = new PriceCalculator(TaxRates.Germany).Calculate(order);

    var expected = new PriceResult(Net: 108.00m, Discount: 12.00m, Tax: 20.52m, Gross: 128.52m, Currency: "EUR");
    Assert.AreEqual(expected, result);
}
```

Because `PriceResult` is a `record`, `Assert.AreEqual` uses value equality, and the failure message
prints both records with all their properties. One run, every difference.

:::caution[Records and collections]
Record equality is shallow for collections. A record with an `IReadOnlyList<PriceLine> Lines`
property compares the *list reference*, so two records with identical lines are not equal. For
results with nested collections, use a deep comparison (a JSON snapshot or an object comparer
that prints the property paths that differ) instead of plain `AreEqual`.
:::

For larger results, I keep the expected object in a JSON file next to the test, the same approach as
in the [API test patterns](/blog/2026-api-test-patterns-get-post-delete/). That scales much better than
fifty lines of object initializer.

### When several asserts are fine

Multiple asserts are fine when they verify **one behaviour from different angles** and you'd want to
see all of them fail together. MSTest has no built-in "assert all", but you can compose a result into
an anonymous object or a record and compare that, which gives you the same "all differences at
once" output:

```csharp
Assert.AreEqual(
    new { Status = OrderStatus.Cancelled, Refunded = true, EventCount = 1 },
    new { cancelled.Status, cancelled.Refunded, EventCount = events.Count });
```

Anonymous types have value equality too, and the failure message prints both sides.

## The smaller habits

**No magic values without a name.** `Calculate(order, 3)` means nothing. `Calculate(order,
roundingMode: RoundingMode.PerLine)` explains itself. For test data, small builders
(`OrderBuilder.WithLine(...)`) keep the arrange part short and the relevant values visible.

**Fakes over mocks where you can.** A hand-written `FakeExchangeRates` with a dictionary is usually
clearer than a mock setup with argument matchers. For time, use `FakeTimeProvider` from
`Microsoft.Extensions.TimeProvider.Testing` instead of `DateTime.UtcNow` behind a custom interface.

**Tests are independent.** No shared mutable static state, no test that relies on another test having
run first. That's also the prerequisite for parallel execution, which in MSTest is one line:

```csharp
[assembly: Parallelize(Scope = ExecutionScope.MethodLevel, Workers = 0)]
```

**Test code is production code.** Same reviews, same analyzers, same refactoring. A test suite that's
treated as second-class code becomes second-class code within a year.

**Test the behaviour, not the implementation.** If a refactoring that doesn't change behaviour breaks
twenty tests, those tests were verifying *how*, not *what*.

## Comparison

| | `Calculate()` with five asserts | `Should_..._When_...` with one logical assertion |
|---|---|---|
| Failure tells you which behaviour broke | ❌ | ✅ from the name alone |
| Failure shows all differences | ❌ first one only | ✅ |
| Readable in a pipeline report | ❌ | ✅ |
| Gaps visible in the test tree | ❌ | ✅ with classes per varying dimension |
| Survives refactoring | ⚠️ depends | ✅ if it compares results, not internals |

## Pitfalls

**Names that describe the implementation.** `Should_Call_Repository_Save_Once` is a name for a
mock-verification test. Ask whether the behaviour can be observed through the result instead.

**Overly long names.** If a name needs three `When`s and an `And`, the test probably verifies more
than one behaviour. Split it.

**Comparing everything, including noise.** Whole-object comparison is great until the object contains
a generated ID or a timestamp. Control those (fixed IDs, `FakeTimeProvider`) instead of excluding them.

**One class per production class, forever.** That's a starting point, not a rule. Split as soon as a
test class needs scrolling to find a test.

## Enforce it

A convention that's only in the wiki will drift. A test can check it:

```csharp
[TestMethod]
public void Should_Follow_Naming_Convention_For_All_Test_Methods()
{
    var pattern = new Regex("^Should(_[A-Z0-9][A-Za-z0-9]*)+$");

    var violations = typeof(PriceCalculator_Tests).Assembly.GetTypes()
        .SelectMany(type => type.GetMethods().Select(method => (type, method)))
        .Where(x => x.method.GetCustomAttributes<TestMethodAttribute>(inherit: true).Any())
        .Where(x => !pattern.IsMatch(x.method.Name))
        .Select(x => $"{x.type.Name}.{x.method.Name}")
        .ToList();

    Assert.AreEqual(0, violations.Count,
        "Rename to Should_<Behaviour>_When_<Condition>:" + Environment.NewLine + string.Join(Environment.NewLine, violations));
}
```

Note that the failure message says what to do, not just that something's wrong. More on that in the
post about [AI-friendly tests](/blog/2026-ai-friendly-tests/). Add the MSTest analyzers on top (they
ship with the MSTest meta package and flag things like invalid test method signatures), and the
basics are checked by the build, which is the idea of
[self-defending codebases](/blog/2026-self-defending-codebases/).

## Summary

- Name tests `[Subject]_Tests.Should_[Behaviour]_When_[Condition]`; the combined name is the **first
  line of every failure report**.
- Split test classes by the **dimension that varies** (overload, input type, business rule), not
  automatically one class per production class.
- **One behaviour, one logical assertion**: compare the whole result so a failure shows every
  difference in one run. Watch out for shallow record equality with collections.
- Prefer **fakes and `FakeTimeProvider`** over elaborate mocks, keep tests **independent** and treat
  test code like **production code**.
- **Enforce the convention with a test**, and make that test's message say how to fix the violation.
