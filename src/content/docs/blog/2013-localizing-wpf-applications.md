---
title: Localizing WPF applications — from LocBaml to markup extensions and RESX tooling
date: 2013-04-23
authors: rene
tags: [retrospective, wpf, localization, tooling]
excerpt: In spring 2013 I worked through every WPF localization approach I could find — BAML extraction, RESX with markup extensions, runtime language switching — and then started writing tools to clean up the resource files that the winning approach left behind.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2013. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

Machine HMIs ship to many countries, and an operator has to be able to read the screen in front of them. In WPF there were several "official" answers, and none of them was obviously right.

My archive from the first half of 2013 is a small museum of that search: about ten folders, most of them dated within a few weeks of each other in March and April. Some are reference samples I downloaded and took apart. Others are my own prototypes and tools. This post goes through what the code shows, roughly in the order I explored it.

## Approach 1: LocBaml and the BAML route

Microsoft's own answer was LocBaml, a command-line sample that works on compiled XAML (BAML). The archive holds the LocBaml source plus a demo application set up for it. The workflow is visible in the files:

1. Set `<UICulture>en-US</UICulture>` in the project so the XAML resources go into a satellite assembly.
2. Give every element an `x:Uid` (`msbuild /t:updateuid` does this for you).
3. Run LocBaml to export every localizable property into a CSV, translate it, and compile a new satellite assembly per language.

The exported CSV shows the problem straight away:

```text
WpfLocalizationLocBaml.g.en-US.resources:startform.baml,frmStartMenuForm:System.Windows.Window.Title,Title,True,True,,WPF Localization Samples
WpfLocalizationLocBaml.g.en-US.resources:startform.baml,frmStartMenuForm:System.Windows.Window.WindowStyle,None,True,False,,SingleBorderWindow
WpfLocalizationLocBaml.g.en-US.resources:startform.baml,frmStartMenuForm:System.Windows.FrameworkElement.Height,None,False,True,,316
```

It doesn't just export text. It exports *everything*: window styles, heights, layout values. A translator gets a file where `316` sits next to the window title. It's powerful (you can even change layout per culture), but every rebuild can shift UIDs, nothing gets checked at compile time, and switching language means restarting the application. For an HMI where the operator changes language at the machine, that last point alone ruled it out.

## Approach 2: RESX plus a markup extension

The second family keeps texts in ordinary `.resx` files and pulls them into XAML through a markup extension. I tried the open-source WPFLocalizeExtension in two throwaway projects, `TestLoc` and `TestWpfLocalizeExtension`:

```xml
<Window xmlns:lex="http://wpflocalizeextension.codeplex.com"
        lex:LocalizeDictionary.DesignCulture="ru"
        lex:ResxLocalizationProvider.DefaultAssembly="TestWpfLocalizeExtension"
        lex:ResxLocalizationProvider.DefaultDictionary="Ressourcen">
    <Grid>
        <Label  Content="{lex:Loc From}" />
        <Button Content="{lex:Loc From}" />
    </Grid>
</Window>
```

The resource files covered `de-DE`, `en-US`, `en-GB`, `hu` and `ru`. Setting `DesignCulture` to Hungarian or Russian was a quick way to check, right in the designer, whether a layout survived much longer strings or a different script.

It worked, but I wanted to understand the mechanism rather than depend on a large library for something that, at its core, is small.

## Approach 3: my own TranslateExtension

[TranslationByMarkupExtension](https://github.com/RenePeuser/TranslationByMarkupExtension) is where I rebuilt the pattern myself. I started from a widely shared sample (its original is still in the `Backup` folder), then split it into `Contracts`, `Data`, `TranslationContext` and `TranslationProvider` folders and filled in the parts the sample had left open.

The trick is that the markup extension doesn't return a string. It returns a **binding** to a small notifying object:

```csharp
public class TranslateExtension : MarkupExtension
{
    public TranslateExtension(string key) { Key = key; }

    [ConstructorArgument("key")]
    public string Key { get; set; }

    public override object ProvideValue(IServiceProvider serviceProvider)
    {
        var binding = new Binding("Value") { Source = new TranslationData(Key) };
        return binding.ProvideValue(serviceProvider);
    }
}
```

`TranslationData` listens for a `LanguageChanged` event through a `WeakEventManager` and raises `PropertyChanged("Value")`. Change the culture, and every bound text in every open window updates. No restart, and no strong references holding views alive:

```csharp
public CultureInfo CurrentLanguage
{
    get { return Thread.CurrentThread.CurrentUICulture; }
    set
    {
        if (value != Thread.CurrentThread.CurrentUICulture)
        {
            Thread.CurrentThread.CurrentUICulture = value;
            OnLanguageChanged();
        }
    }
}
```

A missing key comes back as `!Key!` rather than an empty string, so untranslated texts stand out on screen. The original sample had a `// TODO: Resolve the available languages` that hard-coded `de` and `en`. My version found the languages by scanning for satellite-assembly folders next to the executable:

```csharp
var cultures = CultureInfo.GetCultures(CultureTypes.AllCultures);
foreach (var directory in new DirectoryInfo(Environment.CurrentDirectory).GetDirectories())
{
    var culture = new CultureInfo(directory.Name);
    if (cultures.Contains(culture))
        availableCultures.Add(culture);
}
```

I also added a `"Key".Translate()` string extension, so view models could use the same lookup as XAML.

:::caution[A bug I can see now]
While restructuring, the finalizer `~TranslationData()` lost its tilde and became a private parameterless constructor. So the `RemoveListener` call in it never ran. The weak event manager covered for it, but it's a reminder that moving code around is also a change.
:::

## The cleanup problem: ResxCheckAndReplace

Once texts live in RESX files, the files grow. Keys pile up, and nobody dares to delete one. In mid-April 2013 I wrote a WPF tool for exactly that. Its header comment is honest: *"At the beginning this tool was programmed quick and dirty, it's not perfect but it works."*

It had two jobs:

1. **Find unused keys.** For every non-default `.resx` in a solution folder, read it with `ResXResourceReader`. Search all `*.cs` files for `<ResourceClass>.<Key>`, and write a new resource file that contains only the keys actually used.
2. **Inline a resource class.** Replace every `ResourceClass.Key` in the code with the literal value. This needed escaping, because a RESX value isn't a C# string literal (line breaks become `\n`, quotes need escaping).

The second job had a trap, which the comment explains with an example:

```csharp
// MessageBox.Show(ResxTexte.Text)
// MessageBox.Show(ResxTexte.Text1)
// MessageBox.Show(ResxTexte.TextAbc)
// If you start replacing with the key "Text" you have troubles,
// because it will replace all calls.
```

The comment says to sort keys by length, descending. The code actually sorts the keys in descending string order:

```csharp
return (from item in resultDictionary orderby item.Key descending select item).ToList();
```

That works too, for a reason I find quite neat: any key that extends a prefix sorts *after* the prefix in ascending order, so descending order always handles `TextAbc` before `Text`. Plain text search instead of real parsing is crude, but for a one-off migration over a known code base it did the job. Progress went to the UI through a tiny generic `MessageBroker<TMessage>`, an idea I came back to later.

## Moving into the IDE: LocalizeStrings

Cleaning up afterwards is the expensive way. Two months later, in June 2013, I tried to stop hard-coded strings at the source with [LocalizeStrings](https://github.com/RenePeuser/LocalizeStrings), a Visual Studio add-in (`IDTExtensibility2`, still the old add-in model). You selected a string literal in a C# file and ran the command:

```csharp
public static void TryLocalizeString(DTE2 applicationObject)
{
    CheckActiveDocument(applicationObject);                       // must be a .cs file
    var selectedText = applicationObject.ActiveDocument.Selection as TextSelection;
    var stringToLocalize = ConvertSelectionToLocalizeString(selectedText);
    if (!EditKey(stringToLocalize)) return;                        // WPF dialog, key editable
    WriteLocalizeStringToXml(stringToLocalize);
    ReplaceSelectionText(selectedText, stringToLocalize);
}
```

It suggested a key built from the letters and digits of the text, XML-escaped the value, and swapped the literal for the key. It was clearly a prototype. The target file was still a hard-coded test path.

## Where it ended up (2018)

The idea came back years later as a private `WPF_Localization` solution: a proper VSPackage command, a dialog for the key, and formatters that knew what to generate depending on the language of the active document:

```csharp
switch (currentTextSelection.Document.Language)
{
    case "CSharp": return cSharpTextFormatter.Localize(textToLocalize);
    case "XAML":   return xamlTextFormatter.Localize(textToLocalize);
    default:       return null;
}
```

In C# the selection became a `TranslatableText` field holding key and developer text. In XAML it became a `{TranslateByKey ...}` markup extension. The command also wrote the new entry into the resource file and added a property to a generated wrapper class. The runtime side was recognisably the 2013 design: a markup extension that binds to a notifying `TranslationData`, a weak `LanguageChangedEventManager`, and an `ITranslationProvider`, which was now backed by per-culture XML files instead of RESX. One improvement: in the designer it simply returns the key, so views stay readable at design time.

## Lessons that stuck

- **Localization is a runtime feature for HMIs.** Anything that needs a restart to switch language is the wrong tool when the operator switches at the machine.
- **Return bindings, not values.** A markup extension that hands back a binding to a notifying object gets live updates almost for free.
- **Make missing translations visible.** `!Key!` on screen beats an empty label every time.
- **Resource files need tooling, not discipline.** Unused keys and hard-coded strings don't go away through code review. They go away when a tool finds them, or better, when the IDE makes doing it right the easiest option.

What I'd do today is push that last point further: generate strongly typed accessors from the resource files and add a build-time or Roslyn check that fails on unused keys and on new string literals in view code. That's the same instinct as `ResxCheckAndReplace`, moved from a tool you remember to run into a rule the build enforces.
