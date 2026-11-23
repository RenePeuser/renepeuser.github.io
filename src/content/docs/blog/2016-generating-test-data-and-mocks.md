---
title: Generating test data and mocks automatically
date: 2016-10-15
authors: rene
tags: [retrospective, testing, dotnet, reflection]
excerpt: In 2016 I got tired of building huge object graphs just to pass them from A to B in a unit test. So I wrote an object creator that builds classes, interfaces, collections and delegates on its own, and later went further and generated whole test classes.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2016. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

By 2016 most of my day was WPF and MVVM, and a lot of my tests had the same problem. A component took
a big data container, did something with it and handed it on. The test only cared that the container
*arrived*. Its contents didn't matter. Still, every test began with dozens of lines of `new`, nested
constructors and mock setups, just to get a valid instance.

The README of the repository I started in October 2016 put it plainly: *"If you're only interested in
whether this data container goes from component A to component B, you're not interested in the
specific data of that container."* So I wrote something that builds the data for me.

## One entry point, many strategies

The heart of the
[DynamicMockCreator](https://github.com/RenePeuser/DynamicMockCreator) repository (later renamed
*ObjectCreator*) is a single generic `Create<T>()`. It looks at the type and hands it to a
specialised creator:

```csharp
public static T Create<T>(IDefaultData defaultData, ObjectCreationStrategy strategy)
{
    var type = typeof(T);
    var defaultValue = type.GetDefaultValue(defaultData);
    if (defaultValue != null)
    {
        return (T)defaultValue;
    }

    if (type.IsInterface) return InterfaceCreator.Create<T>(type, defaultData, strategy);
    if (type.IsAbstract)  return AbstractClassCreator.Create<T>(type, defaultData, strategy);
    if (type.IsArray)     return ArrayCreator.Create<T>(type, defaultData, strategy);
    if (type.IsAction())  return ActionCreator.Create<T>(type);
    if (type.IsFunc())    return FuncCreator.Create<T>(type, defaultData, strategy);
    if (type.IsTask())    return TaskCreator.Create<T>(type, defaultData, strategy);

    return UnknownTypeCreator.CreateDynamicFrom<T>(type, defaultData, strategy);
}
```

Primitive types and strings come from an `IDefaultData` provider. Anything else gets taken apart.
For a concrete class, the creator picks a constructor, creates every parameter *recursively* through
the same `Create` call, calls `Activator.CreateInstance` and then fills any writable property that
still holds its default value. The recursion is what makes it work: a constructor that needs an
`IOrderService` and a `List<Customer>` gets a substitute and a filled list. It never needs to know
what those types are.

The test then shrinks to its intent:

```csharp
[TestMethod]
public void CreateContainerClass()
{
    Assert.IsNotNull(ObjectCreatorExtensions.Create<Container>());
}
```

## Interfaces become fully set-up substitutes

For interfaces I used NSubstitute, through reflection, because the type is only known at runtime.
After creating the proxy, the creator walks over every property and every non-void method and
registers a generated return value:

```csharp
internal static T SetupMethods<T>(this T mock, IDefaultData defaultData, ObjectCreationStrategy strategy)
{
    foreach (var methodInfo in typeof(T).GetAllMethods())
    {
        if (methodInfo.ReturnType == typeof(void))
        {
            continue;
        }

        var returnValue = methodInfo.ReturnType.Create(defaultData, strategy);
        var anyArgs = methodInfo.GetParameters()
                                .Select(p => ArgAnyFunc(p.ParameterType))   // Arg.Any<T>() via reflection
                                .ToArray();

        var call = methodInfo.Invoke(mock, anyArgs);
        ReturnsFunc(methodInfo.ReturnType, call, returnValue, methodInfo.ReturnType.ToArray(0));
    }

    return mock;
}
```

`ReturnsFunc` and `ArgAnyFunc` are small delegates that call NSubstitute's generic `Returns<T>` and
`Arg.Any<T>` with `MakeGenericMethod`. My commit message from that day just says *"add crazy setup
function. makes a setup for all properties and methods for a mock interface"*. That sums up how it
felt: you ask for an `IPersonModel` and you get a mock whose properties and methods all return
something sensible, recursively.

## Delegates built from expression trees

`Func<...>` parameters were their own little puzzle. You can't `Activator.CreateInstance` a lambda.
In November 2016 I switched to building them with expression trees. I create one parameter
expression per input argument and a body that returns a pre-created constant, then compile it:

```csharp
internal static object Create(Type funcType, IDefaultData defaultData, ObjectCreationStrategy strategy)
{
    var genericArguments = funcType.GetGenericArguments();
    var parameters = genericArguments.Take(genericArguments.Length - 1)
                                     .Select(Expression.Parameter);

    var outputType = genericArguments.Last();
    var returnValue = Expression.Constant(outputType.Create(defaultData, strategy));
    var label = Expression.Label(outputType);
    var body = Expression.Block(Expression.Label(label, returnValue));

    return Expression.Lambda(body, parameters).Compile();
}
```

## Making it configurable and fast

Two knobs turned out to matter. An `ObjectCreationStrategy` struct controls whether properties and
methods get set up, how many items go into generated collections, and which type to use for
open generic parameters. And `IDefaultData` decides what primitives look like. That can be fixed
values for deterministic asserts, or a `RandomDefaultData` that picks from small pools of numbers,
words and dates.

The test suite pushed it hard. There are test classes that try to create every type in
`System.Collections`, `System.Collections.Generic`, `System.Collections.Specialized` and
`System.Collections.Immutable`. Around Christmas 2016 I restructured enumerables, enumerators and
dictionaries into separate creators. One commit claims it was *"2x–2.5x faster than AutoFixture"*
at that point. I want to be honest here: the repository has a `PerformanceTest` class that compares
`Activator`, reflection and `new` for lists, but no recorded AutoFixture comparison. So read that
as the excitement of a December evening, not as a benchmark.

:::tip[A side effect I liked]
Random data plus interface substitutes also gives you **design-time data for XAML**. A tiny attached
property, `DesignTimeAttachedProperties.DesignTimeType="{x:Type local:IMainWindowViewModel}"`,
creates the view model in the background and sets it as the `DataContext`. No hand-written
design-time mocks that drift away from the real interfaces.
:::

## Hiding the mocking framework

Around the same time I tried another idea in
[AbstractMockingFramework](https://github.com/RenePeuser/AbstractMockingFramework). Could tests talk
to an abstraction instead of Rhino Mocks or NSubstitute directly, so that switching frameworks
wouldn't mean rewriting thousands of tests?

```csharp
public interface IMockingFrameworkProvider
{
    T CreateMock<T>(params object[] argumentsForConstructor) where T : class;
    ISetupResultBase CreateSetup<T, R>(T mock, Func<T, R> func) where T : class;
    void SetupReturn<TValue>(ISetupResultBase mock, TValue value);
    void AssertWasCalled<T>(T mock, Action<T> action, int expectedCallCount = 1) where T : class;
}
```

The tests then read as `_personModel.Setup(p => p.Calculate()).Returns(888);`, whichever provider
sits behind it. It stayed a prototype (event assertions were never finished), but it showed me where
the seams between test code and test tooling should be.

[ExtendedAsserts](https://github.com/RenePeuser/ExtendedAsserts) came from the same line of thought.
It's a set of `Asserts.IsSealed<T>()`, `Asserts.IsInterface<T>()` and similar helpers. The aim was to
check the *contract* of a type, not just its behaviour.

## From generated data to generated tests

The next step was obvious: if I could generate the inputs, why not the tests themselves? In 2017 I
built a Visual Studio extension prototype. You right-click a XAML file, it finds the matching test
project, parses the XAML and writes view-test classes from XML code templates. A binding in the view
turns into a test like this (identifiers simplified):

```csharp
[TestMethod]
public void $Property$_Must_Bound_To_Expected_Source()
{
    Control.AssertIsBoundTo(control => control.$Property$, () => ViewModel.$ViewModelProperty$, $BindingParameters$);
}
```

In 2019 I rebuilt the idea as a cleaner pipeline. There's a XAML parser that turns
`{Binding Path=IsEnabled, Mode=OneWay, Converter={StaticResource MyConverter}}` into a typed binding
model. A set of `ITestMethodBuilder`s each declare which property values they can handle:

```csharp
public class BindingTestMethodBuilder : ITestMethodBuilder
{
    public Predicate<XamlProperty> IsThisTheTestMethodBuilderFor { get; } =
        item => item.PropertyValue is XamlBinding;

    public TestMethod BuildFrom(XamlProperty property) => property switch
    {
        XamlAttachedProperty attached => BuildFromAttachedProperty(attached),
        _ => BuildFromProperty(property)
    };
}
```

A selector picks the first matching builder per property. Bindings, static and dynamic resources and
plain values each get their own builder. The parser has its own tests, one class per XAML construct.

## Lessons that stuck

- **Tests should state intent, not construction.** If half a test is setup that doesn't affect the
  assertion, that setup belongs in a tool.
- **Recursion over the type system is a superpower, and a trap.** It handles cases you never thought
  of. But open generics, `Task<T>`, enumerators and immutable collections each needed special care,
  and the test suite for the creator ended up larger than the creator.
- **Generated tests are only as good as their templates.** A generator makes good conventions cheap
  and bad ones cheap too.
- **Test your test helpers.** In ExtendedAsserts, `IsPublic<T>()` accidentally asserts
  `IsNotPublic`. That's a copy-paste slip that no test caught, because there were none for the
  helpers themselves.

What I'd do today: reach for an established library such as AutoFixture with an NSubstitute
customisation for the data part. I'd also build test *affordances* into the framework itself
instead of generating test code from the outside. That idea came back years later in my ASP.NET Core
test SDKs.
