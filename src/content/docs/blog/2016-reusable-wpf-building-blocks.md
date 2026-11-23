---
title: Reusable WPF building blocks and separating domain from technology
date: 2016-06-05
authors: rene
tags: [retrospective, wpf, mvvm, architecture]
excerpt: On a single Sunday in June 2016 I pushed half a dozen tiny WPF repositories to GitHub, each solving exactly one recurring annoyance. Looking back, that was the moment I stopped writing applications only and started writing the pieces applications are built from.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2016. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

On 5 June 2016 I created `OptimizedBindingBase`, `MarkupExtensionConverter`, `TypeToDataTemplateSelector`, `TypeToStyleSelector` and `CompositeObservableCollection` on GitHub, all on the same day, all public. `CompositeCollection`, `CustomSort` and a shared `Extensions` library followed that week. Each one is small, often under 150 lines, and each one does one thing.

None of them is clever on its own. What matters is the habit behind them: once I'd solved the same WPF problem in three projects, I pulled the solution out, gave it a name and published it. This post is about that habit, and where it came from.

## Where it started: hiding the technology (2014)

Two years earlier, an experiment called [MEF_Trennung_Fachlichkeit_Technik](https://github.com/RenePeuser/MEF_Trennung_Fachlichkeit_Technik) ("separating domain logic from technology") put the idea into words. Its central class wraps the MEF container. The German doc comment states the goal:

```csharp
/// <summary>
/// Static class that loads the individual DLLs.
/// The IoC container is encapsulated here so that the program itself
/// contains no hint of which technology is used to load the DLLs.
/// </summary>
public static class AssemblyService
{
    private static readonly CompositionContainer _compositionContainer =
        new CompositionContainer(new DirectoryCatalog(Environment.CurrentDirectory));
    private static readonly Dictionary<Type, object> _assemblyCache = new Dictionary<Type, object>();

    public static Lazy<T, TMetadata> GetModule<T, TMetadata>()
        where T : class where TMetadata : ICustomExport
    {
        if (!_assemblyCache.ContainsKey(typeof(Lazy<T, TMetadata>)))
        {
            var result = _compositionContainer.GetExport<T, TMetadata>();
            if (result != null)
                _assemblyCache.Add(typeof(Lazy<T, TMetadata>), result);
        }
        return _assemblyCache[typeof(Lazy<T, TMetadata>)] as Lazy<T, TMetadata>;
    }
}
```

Plug-ins were marked with a custom `[CustomExport(typeof(IPlugIn<,>), ModuleName = "...")]` metadata attribute, and the host asked for `IPlugIn<string, int>` without knowing MEF existed. A small `MessageBroker` keyed by type let modules talk to each other without references.

Seen from 2026, it's a static service locator, which is exactly what I'd argue against today. But the intent was right, and it's still the core of how I think about architecture: **domain code shouldn't know which framework carries it.**

The 2013 folders around it (`Behaviors`, `VisualStateTest`, `CommandStatus`, `ResourceDictionary`, `LoadingScreen`) are smaller. They're experiments with Blend behaviours, visual states, a `DelegateCommand` extended with an "is active" predicate for toggle buttons, and loading a `ResourceDictionary` from an assembly at runtime. They aren't building blocks yet, just me learning where WPF's extension points are.

## Less ceremony per property: OptimizedBindingBase

Every view model property in classic WPF is the same ten lines: backing field, equality check, assignment, `OnPropertyChanged("Name")`. [OptimizedBindingBase](https://github.com/RenePeuser/OptimizedBindingBase) shrinks that to one line each way by storing values in a dictionary keyed by `[CallerMemberName]`:

```csharp
public abstract class BindingBaseOptimized : BindingBase
{
    private readonly Dictionary<string, object> _propertyFieldDictionary = new Dictionary<string, object>();

    public T Get<T>([CallerMemberName] string propertyName = "")
    {
        return _propertyFieldDictionary.ContainsKey(propertyName)
            ? _propertyFieldDictionary[propertyName].Cast<T>()
            : default(T);
    }

    public bool Set<T>(T newValue, [CallerMemberName] string propertyName = "")
    {
        if (newValue.EqualityEquals(Get<T>(propertyName))) return false;
        _propertyFieldDictionary[propertyName] = newValue;
        OnPropertyChanged(propertyName);
        return true;
    }
}
```

```csharp
public int Count
{
    get { return Get<int>(); }
    set { if (Set(value)) { /* react only to real changes */ } }
}
```

Returning `bool` from `Set` turned out to be the useful part: "do something only if the value actually changed" became a one-liner. The trade-offs are boxing for value types and a dictionary lookup per access. That was acceptable for view models, and not something to put in a hot loop. The same `Get`/`Set` pattern turns up again, renamed, in a 2018 localization tool of mine.

## Converters without resource boilerplate: MarkupExtensionConverter

Using an `IValueConverter` normally means declaring it in resources first and then referencing it with `StaticResource`. [MarkupExtensionConverter](https://github.com/RenePeuser/MarkupExtensionConverter) makes the converter its own markup extension, with a shared singleton instance created through the curiously recurring generic pattern:

```csharp
public abstract class MarkupExtensionConverterBase<T> : MarkupExtension where T : new()
{
    private static readonly T Instance = new T();

    public sealed override object ProvideValue(IServiceProvider serviceProvider)
    {
        return Instance;
    }
}

public abstract class GenericMarkupExtensionConverter<T, TSourceValue> : MarkupExtensionConverter<T>
    where T : GenericMarkupExtensionConverter<T, TSourceValue>, new()
{
    public sealed override object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        return Convert(ValidateValue(value) ? value.Cast<TSourceValue>() : default(TSourceValue));
    }

    public abstract object Convert(TSourceValue value);
    public abstract TSourceValue ConvertBack(object value);
}
```

A concrete converter is then a typed method, and XAML uses it directly: `Converter={local:MyConverter}`. A `OneWay` variant seals `ConvertBack`, so nobody has to write `throw new NotImplementedException()` again. `ValidateValue` filters out `DependencyProperty.UnsetValue` and `null` before the cast, so a typed converter never sees them.

## Configuration in XAML: type-based selectors

[TypeToDataTemplateSelector](https://github.com/RenePeuser/TypeToDataTemplateSelector) and [TypeToStyleSelector](https://github.com/RenePeuser/TypeToStyleSelector) replace the "one selector class per screen" pattern with a single selector that is configured in XAML:

```xml
<local:TypeDataTemplateSelector x:Key="TypeToDataTemplateSelector">
    <local:TypeDataTemplateSelector.TypeToDataTemplates>
        <local:TypeToDataTemplate Type="{x:Type system:String}" DataTemplate="{StaticResource StringTemplate}" />
        <local:TypeToDataTemplate Type="{x:Type system:Int32}"  DataTemplate="{StaticResource IntTemplate}" />
    </local:TypeDataTemplateSelector.TypeToDataTemplates>
</local:TypeDataTemplateSelector>
```

The implementation is a `FirstOrDefault(t => t.Type == item.GetType())`. That means exact type matches only, no base classes or interfaces. It covered my use cases then, and it's the first thing I'd extend now.

## Collections and sorting without leaking the view

[CompositeObservableCollection](https://github.com/RenePeuser/CompositeObservableCollection) exists for a pragmatic reason, as its README says: some third-party controls didn't support WPF's built-in `CompositeCollection`. So I built an `ObservableCollection<object>` that merges several source collections and mirrors their `Add`, `Replace`, `Move` and `Reset` changes, keeping each source's items in its own block. A multi-value converter makes it usable straight from XAML:

```xml
<DataGrid.ItemsSource>
    <MultiBinding Converter="{local:ObservableCollectionsToCompositionCollectionConverter}">
        <Binding Path="Persons"/>
        <Binding Path="VirtualPersons"/>
        <Binding Path="SpecialPersons"/>
    </MultiBinding>
</DataGrid.ItemsSource>
```

:::caution[Found while writing this]
The `Remove` branch calls `RemoveRange(newItems)`, but for a remove, `NewItems` is null and the removed items are in `OldItems`. A unit test would have caught it on day one. This repository had none.
:::

[CustomSort](https://github.com/RenePeuser/CustomSort) and [CompositeCollection](https://github.com/RenePeuser/CompositeCollection) handle the next problem: fast custom sorting in a `DataGrid` *without* the view model knowing about `ListCollectionView`. A Blend behaviour intercepts `DataGrid.Sorting`, flips the direction, and sets `ListCollectionView.CustomSort` to a comparer that is declared in XAML. Comparers derive from a generic base that does the casting:

```csharp
public class PersonCustomComparer : DataGridCustomSortComparerGenericBase<PersonCustomComparer, Person>
{
    protected override int Compare(Person obj1, Person obj2)
    {
        switch (DataGridColumn.Header.ToString())
        {
            case "Name":       return StringCompare(obj1.Name, obj2.Name);
            case "FamilyName": return StringCompare(obj1.FamilyName, obj2.FamilyName);
        }
        return 0;
    }
}
```

The view model stays a plain list of objects. Sorting is a view concern and stays in the view.

## 2017: bindings that notice collections, events by interface

Two follow-ups from 2017 complete the set. [ObservableBinding](https://github.com/RenePeuser/ObservableBinding) is a markup extension that creates a normal `Binding` and also watches the bound object. If the bound object is an `INotifyCollectionChanged`, it calls `UpdateTarget()` whenever the collection changes, and it re-attaches when the property on the data context is replaced. That lets a converter like `ContainsAny` re-run when an item is added, which a plain binding never does.

[GenericEventAggregator](https://github.com/RenePeuser/GenericEventAggregator) is the grown-up version of the type-keyed `MessageBroker<T>` I'd written in 2013 for a resource-cleanup tool. Subscribers just implement an interface per message type:

```csharp
public interface IEvent<in TEventArg> : IEvent where TEventArg : class
{
    void OnReceived(TEventArg eventArg);
}

public void Publish<TEventArg>(TEventArg genericEvent) where TEventArg : class
{
    var subscribers = attachedObjects.OfType<IEvent<TEventArg>>();
    subscribers.ForEach(subscriber => subscriber.OnReceived(genericEvent));
}
```

An `EventAggregatorWithCache` variant remembers the last event per type and replays it to late subscribers, so a status view that opens after the event was published still shows the current state. The weakness is visible too: `attachedObjects` holds strong references, so forgetting `UnSubscribe` leaks the subscriber.

Smaller pieces from the same period include [GirdToAlignControls](https://github.com/RenePeuser/GirdToAlignControls), an attached property that paints an alignment grid, and [Extensions](https://github.com/RenePeuser/Extensions), the shared extension-method library (`Cast<T>`, `EqualityEquals`, `ForEach`, XML helpers) that the others reference. Commit messages like *"remove static extensions and reference my omega extensions lib"* show the consolidation happening in real time. It was also the one repository with real unit tests, for its XML helpers.

## Lessons that stuck

- **Extract on the third repetition.** Every one of these repositories started as code I'd already written several times inside applications.
- **Make the reusable thing configurable from XAML.** Selectors, converters, comparers and behaviours you can declare in markup get reused. Base classes you have to inherit from get copied.
- **Keep the view's concerns in the view.** `ListCollectionView`, sorting and composite collections were all ways of keeping view models plain.
- **Hide the technology behind your own contract.** The 2014 MEF experiment got the mechanism wrong (a static locator) but the principle right.
- **Small libraries still need tests.** The bugs I found while writing this post were all in the repositories without tests.

What I'd do today: package these as one versioned NuGet library instead of a dozen loose repositories, replace `BindingBaseOptimized` with source-generated properties, use weak references in the aggregator, inject the composition root instead of using a static locator, and add a test project to every one of them. That last step is the one my later work, from Roslyn rules to test SDKs, is really about.
