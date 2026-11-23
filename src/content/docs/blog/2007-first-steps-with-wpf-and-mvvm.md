---
title: First steps with WPF and MVVM
date: 2007-10-15
authors: rene
tags: [retrospective, wpf, mvvm, xaml]
excerpt: Coming from VB6 forms, WPF felt like a different planet. Looking at my oldest WPF folders, I can trace how I learned it — chapter by chapter, and then with a first, slightly naive MVVM demo.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2007. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

When I moved from VB6 to .NET, WPF was still young. Coming from a world of forms, fixed pixel
positions and event handlers behind every button, it felt like a different planet: XAML, dependency
properties, routed events, templates, data binding.

My oldest WPF folders show very clearly *how* I learned it. Not by building a product first, but by
working through the platform systematically.

## Learning by chapter

The oldest WPF material in my archive is not my own code, and I want to be upfront about that. It is
the sample code of a comprehensive German WPF handbook, organized by chapter: folders `K01` to `K20`
("Kapitel" is German for chapter), plus the book's complete sample application. The earliest snapshot
is dated October 2007, the last one early 2009.

What I find interesting today is not the code itself but the learning path it documents. Reading the
folder names is like reading a syllabus:

- **XAML basics** — namespaces, property element syntax, content properties, type converters, markup
  extensions.
- **Layout** — `Grid`, `DockPanel`, `StackPanel`, shared size groups, render and layout transforms.
- **Dependency properties and routed events** — attached properties, class handlers,
  `Source` versus `OriginalSource`, the `Handled` flag.
- **Commands** — from a simple exit command to input bindings declared in XAML.
- **Resources, styles and templates** — static versus dynamic resources, merged dictionaries,
  triggers, data templates, control templates with named `PART_` elements.
- **Data binding** — binding modes, `UpdateSourceTrigger`, `INotifyPropertyChanged`, value converters,
  multi-bindings, collection views with sorting, filtering and grouping, and validation rules.
- **Interop** — WinForms in WPF, WPF in WinForms, ActiveX in WPF, Win32 in both directions.

That last chapter turned out to be prophetic. A few years later, hosting WPF inside existing
non-WPF applications became one of the main topics of my work.

:::tip[Why this mattered for me]
Coming from VB6, the hardest part was not the syntax. It was unlearning the idea that the UI *is* the
code. Data binding, templates and commands all push in the same direction: the visual tree is a
projection of state, not the place where state lives.
:::

## A first MVVM demo

Around October 2008 the archive contains a small, separate solution: an
[MVVM demo](https://github.com/RenePeuser/MVVM) with a person list and a person editor. It is a
classic early MVVM sample — a data library with `Person` and `Address`, a fake database, and view
models that wrap the data objects.

The view model wraps the model and raises `PropertyChanged` itself:

```csharp
public class PersonViewModel : INotifyPropertyChanged
{
    private readonly Person _person;

    public string FirstName
    {
        get { return _person.FirstName; }
        set
        {
            if (_person.FirstName != value)
            {
                _person.FirstName = value;
                OnPropertyChanged("FirstName");
            }
        }
    }

    public bool IsSelected { get; set; }

    public event PropertyChangedEventHandler PropertyChanged;

    protected virtual void OnPropertyChanged(string propertyName)
    {
        if (PropertyChanged != null)
            PropertyChanged(this, new PropertyChangedEventArgs(propertyName));
    }
}
```

The list view does something I still like: instead of reading `SelectedItem` in code-behind, an item
container style binds each row's selection state straight into its view model.

```xml
<UserControl.Resources>
    <Style TargetType="{x:Type ListViewItem}">
        <Setter Property="IsSelected" Value="{Binding IsSelected, Mode=TwoWay}" />
    </Style>
</UserControl.Resources>

<ListView ItemsSource="{Binding People}">
    <ListView.View>
        <GridView>
            <GridViewColumn Header="FirstName" DisplayMemberBinding="{Binding FirstName}" />
            <GridViewColumn Header="LastName"  DisplayMemberBinding="{Binding LastName}" />
            <GridViewColumn Header="Birthday"  DisplayMemberBinding="{Binding Birthday}" />
        </GridView>
    </ListView.View>
</ListView>
```

And there is a command, implemented as a private nested class of the list view model:

```csharp
private class EditCommand : ICommand
{
    private readonly PersonListViewModel _list;

    public EditCommand(PersonListViewModel list) { _list = list; }

    public bool CanExecute(object parameter)
    {
        return _list.People.Any(p => p.IsSelected);
    }

    public event EventHandler CanExecuteChanged;

    public void Execute(object parameter)
    {
        var selected = _list.People.FirstOrDefault(p => p.IsSelected);
        if (selected == null) return;

        var editor = new PersonEditor { DataContext = selected };
        editor.ShowDialog();
    }
}
```

(The original uses `foreach` loops instead of LINQ; I shortened it here.)

## Reading it with 2026 eyes

This demo is a nice snapshot of where everyone was in 2008. The shape is right — models, view models,
views, bindings, a command — but several details show that the pattern was still being figured out:

- **The view model opens a window.** `Execute` creates a `PersonEditor` and calls `ShowDialog()`. The
  view model knows about a concrete view, which makes it impossible to unit-test without a UI.
- **The command is not bound.** The main window has an `Edit` button with a `Click` handler in
  code-behind that calls `Edit.Execute(null)`. The `ICommand` exists, but WPF never sees it, so
  `CanExecute` never enables or disables anything.
- **`CanExecuteChanged` is never raised.** Even if the button were bound, it would not update when
  the selection changes.
- **`IsSelected` does not notify.** It is an auto-property, so the view model can never push a
  selection change back to the view.
- **The editor edits live.** The dialog binds directly to the same view model, so there is no
  cancel: every keystroke changes the data immediately.

None of this is unusual for the time. Reusable `RelayCommand`/`DelegateCommand` implementations,
dialog services and messengers became common only later, exactly because many people ran into
these problems.

My archive also contains two 2011 solutions with promising names, `Learning` and `ItemManagement`.
In all honesty, both are untouched *File → New Project* templates — one of them has an empty
`MainWindowViewModel` class and nothing else. Not every folder is a milestone.

## Lessons that stuck

- **Learn the platform before the patterns.** Working through binding, templates and routed events
  in depth made MVVM obvious later. MVVM is just a disciplined way of using what WPF already offers.
- **A view model that creates views is not a view model.** Navigation and dialogs belong behind an
  abstraction that tests can replace.
- **Commands are a contract with the UI.** If `CanExecute` cannot change, or nobody binds to it, the
  command is just a method with extra steps.
- **Bind state, not events.** The `IsSelected` style trick was my first taste of pushing UI state
  into the view model instead of reading it out of controls, and I have preferred that direction
  ever since.
