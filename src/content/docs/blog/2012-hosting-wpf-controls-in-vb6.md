---
title: Hosting WPF controls in VB6 via COM interop
date: 2012-07-02
authors: rene
tags: [retrospective, vb6, wpf, interop]
excerpt: You cannot rewrite a large VB6 user interface in one go. In 2012 I spent weeks prototyping the alternative — wrapping WPF controls as ActiveX controls that a VB6 form can host, one control at a time.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2012. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

By 2012 I had been writing WPF for a few years, but a lot of industrial user interfaces were still
VB6. Large, working, battle-tested VB6 applications. Nobody wants to rewrite something like that in
one go: a big-bang rewrite stops feature work for a long time, and it throws away years of embedded
knowledge about how the machine and its operators actually behave.

The question I kept coming back to was: **can WPF be brought into an existing VB6 UI piece by piece?**

My archive from June and July 2012 is essentially one long answer to that question: a dozen small
repositories, each probing one part of the problem. Two years later, a consolidated toolkit came out of
it.

## The building blocks

VB6 understands COM and ActiveX controls. WPF understands neither directly. The bridge needs three
layers:

1. **A WPF `UserControl`** — the actual new UI, written in XAML.
2. **A WinForms `UserControl` with an `ElementHost`** — WinForms can host WPF content via
   `System.Windows.Forms.Integration.ElementHost`.
3. **COM exposure** — the WinForms control is registered as an ActiveX control, so the VB6 IDE can put
   it into its toolbox and drop it on a form.

For the third layer I used the *VB6 InteropUserControl* template of the Interop Forms Toolkit. It
generates a VB.NET `UserControl` with a `<ComClass>` attribute, COM registration functions and quite a
bit of plumbing to make a .NET control behave like a well-mannered ActiveX control.

:::note
Most of the interop plumbing in these projects is template-generated code. What I wrote was the WPF
side, the wrapper API exposed to VB6, the hosting setup and the experiments around them. I will be
clear below about which is which.
:::

## Layer 1: the WPF control

In the [2014 toolkit](https://github.com/RenePeuser/VB6_WPF_Toolkit), every WPF control lives in a
separate control library and has deliberately tiny code-behind. It exposes the inner WPF element and
translates WPF events into simple, VB6-friendly ones:

```xml
<UserControl x:Class="Controls.WpfSliderControl"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid>
        <Slider Name="_slider" MinHeight="20" MinWidth="40"
                HorizontalAlignment="Stretch" VerticalAlignment="Stretch" />
    </Grid>
</UserControl>
```

```vb
Namespace Controls
    Public Class WpfSliderControl

        Public ReadOnly Property SliderControl As Slider
            Get
                Return _slider
            End Get
        End Property

        Private Sub _slider_ValueChanged(sender As Object,
                e As RoutedPropertyChangedEventArgs(Of Double)) Handles _slider.ValueChanged
            RaiseEvent SliderValueChanged(e.NewValue)
        End Sub

        Public Event SliderValueChanged(ByVal value As Double)

    End Class
End Namespace
```

The important detail is the event signature. VB6 cannot do anything useful with a
`RoutedPropertyChangedEventArgs(Of Double)`. It can handle `SliderValueChanged(ByVal value As Double)`.

## Layer 2: hosting it in an `ElementHost`

The ActiveX-facing class is a WinForms `UserControl`. Its designer file creates an `ElementHost` and
sets the WPF control as its child. This is the version from the early
[WPFButton](https://github.com/RenePeuser/WPFButton) prototype, trimmed:

```vb
Private WithEvents wpfButtonEvents As WPFButtonTemplate.WPFButtonTemplate
Private wpfButton As New WPFButtonTemplate.WPFButtonTemplate

Private Sub InitializeComponent()
    Dim elementHost As New ElementHost

    elementHost.Dock = System.Windows.Forms.DockStyle.Fill
    elementHost.Child = wpfButton

    Me.Controls.Add(elementHost)
End Sub
```

In the [WPFProgressbar](https://github.com/RenePeuser/WPFProgressbar) prototype the host is docked
*and* the control additionally resizes it by hand in its `Resize` handler — a belt-and-braces fix that
tells you sizing inside a VB6 container did not just work out of the box.

## Layer 3: making it a COM citizen

The wrapper class carries a `<ComClass>` attribute with three GUIDs — class, interface and events.
Everything public on the class becomes part of the COM interface VB6 sees. Below the generated block,
I added the actual API, delegating to the WPF control. From the 2014 toolkit, trimmed:

```vb
<ComClass(WpfSlider.ClassId, WpfSlider.InterfaceId, WpfSlider.EventsId)>
Public Class WpfSlider

    ' COM identity: changing these breaks every compiled VB6 client.
    Public Const ClassId As String = "a04204fe-69d4-4e3a-bd62-821a83c7f92d"
    Public Const InterfaceId As String = "..."
    Public Const EventsId As String = "..."

    <ComRegisterFunction()>
    Private Shared Sub Register(ByVal t As Type)
        ComRegistration.RegisterControl(t)   ' template helper
    End Sub

    ' ... generated focus, validation and lifetime plumbing ...

    Public Property Value As Double
        Get
            Return _wpfSliderControl.SliderControl.Value
        End Get
        Set(value As Double)
            _wpfSliderControl.SliderControl.Value = value
        End Set
    End Property

    Public Property Orientation As Integer
        Get
            Return _wpfSliderControl.SliderControl.Orientation
        End Get
        Set(value As Integer)
            _wpfSliderControl.SliderControl.Orientation = value
        End Set
    End Property

    Private Sub _wpfSliderControl_SliderValueChanged(value As Double) _
            Handles _wpfSliderControl.SliderValueChanged
        RaiseEvent SliderValueChanged(value)
    End Sub

    Public Event SliderValueChanged(ByVal Value As Double)

End Class
```

Note `Orientation As Integer`: the WPF enum is flattened to a plain number, because VB6 does not know
WPF's types. The whole wrapper is an exercise in translating a rich .NET API into the small vocabulary
VB6 understands — numbers, strings, booleans, OLE colors and parameterless or simple-typed events.

The project file sets `RegisterForComInterop` to `true`, so building also registers the control. The
template's registration helper then writes the extra registry keys ActiveX hosts expect, such as the
`Control` key and the `MiscStatus` flags. For deployment, the `WPFProgressbar` repo even contains a
Visual Studio setup project ("WPFProgressbar for VB6") that installs the control, its WPF template
assembly, the toolkit runtime and the type libraries, and marks them for COM registration.

## How VB6 sees it

Once registered, the control shows up in the VB6 toolbox like any other OCX. In the
[VB6-WPF-Ribbon](https://github.com/RenePeuser/VB6-WPF-Ribbon) test project, the form file shows that
the WPF progress bar's .NET properties are persisted by the VB6 designer:

```vb
Begin WPFProgressbarCtl.WPFProgressbar WPFProgressbar1
   Height          =   372
   Left            =   120
   Top             =   2640
   Width           =   1572
   ForegroundColor =   "-2147483630"
   BackgroundColor =   "-2147483633"
   Minimum         =   "0"
   Maximum         =   "100"
   Value           =   "0"
End
```

Those negative color values are OLE system colors, which is why the template converts colors with
helpers like `GetOleColorFromColor` instead of exposing `System.Drawing.Color`.

The same VB6 project also tries a second, cruder approach: instead of an ActiveX control, it shows a
complete .NET interop *form* and re-parents it into a `PictureBox` with the Win32 `SetParent` call.

```vb
Private Declare Function SetParent Lib "user32" _
    (ByVal hWndChild As Long, ByVal hWndNewParent As Long) As Long

Private Sub Form_Load()
    Dim ribbon As New RibbonControlForm.RibbonForm
    ribbon.Show
    ribbon.BorderStyle = 0
    Call SetParent(ribbon.GetHandle, Me.Picture1.hWnd)
    ribbon.Move 0, 0, Me.Picture1.Width, Me.Picture1.Height
End Sub
```

It works for whole regions of a screen, like a ribbon, but it bypasses everything VB6 knows about
child controls: focus, tab order, resizing and lifetime are all on you.

## The experiments around it

Not every repository from that summer is a success story, and that is what makes them interesting:

- [WPFControlsToVB6](https://github.com/RenePeuser/WPFControlsToVB6) and
  [TestToolKitVB6](https://github.com/RenePeuser/TestToolKitVB6) try to put several interop controls
  into one assembly — mostly generated scaffolding, the first step towards a toolkit.
- [WPFTabControl](https://github.com/RenePeuser/WPFTabControl) contains a generic `Loader<T>` that
  scans all DLLs in the working directory and instantiates every type implementing `T`.
  [InterfaceVB6_WPF](https://github.com/RenePeuser/InterfaceVB6_WPF) defines the matching contract:
  an interface with a single `UIElement UiElement { get; }` property. The idea: one generic host
  control, with WPF content discovered as plug-ins instead of one OCX per screen.
- A private ribbon prototype hosts the native Windows ribbon (through a WinForms wrapper library)
  inside an interop user control, next to the WPF `Ribbon` used later in the toolkit.
- [WPF_NumPad](https://github.com/RenePeuser/WPF_NumPad) and
  [WPF_VB6_Toolkit](https://github.com/RenePeuser/WPF_VB6_Toolkit) are WPF control skeletons that
  never got far beyond the template.

The WPFButton prototype also still has its debugging traces: a WPF event literally named `tEST` and
`MsgBox("Vb6 OCX Event reached")` calls to prove that an event actually crossed the boundary. When
you are debugging across a COM boundary, a message box is sometimes the most honest tool you have.

## The 2014 toolkit

The [VB6_WPF_Toolkit](https://github.com/RenePeuser/VB6_WPF_Toolkit) snapshot from 2014 is where the
prototypes converge. It has a clear structure:

- a **control templates** library with the WPF controls (button, slider, progress bar, image,
  password box, media element, document viewer, tab control, ribbon),
- one **interop wrapper** per control in a single COM-visible assembly, each exposing a VB6-shaped
  API (for example `OpenMediaElement`, `PlayMedia`, `Pause` and `SpeedRatio` on the media element),
- a **WinForms test harness** that hosts the WPF controls via `ElementHost` without VB6, so the WPF
  side can be checked in isolation,
- and an unfinished **MEF plug-in experiment** — a `DirectoryCatalog`-based loader and an `IPlugIn`
  interface, the 2012 `Loader<T>` idea rebuilt on a proper composition framework.

Compared to 2012, the API also matured: the 2012 progress bar exposed `Minimum`, `Maximum` and
`Value` as `Integer`, while the 2014 slider uses `Double`, matching WPF instead of truncating it.

## Pitfalls visible in the code

Reading this code again, the pitfalls are all there in plain sight:

- **Name clashes with WinForms.** `Click`, `Visible` and `Enabled` already exist on a WinForms
  `UserControl`, so the wrapper has to `Shadows` them to present VB6-style members.
- **Focus and tabbing.** The template overrides `WndProc` to translate `WM_SETFOCUS` and
  `WM_PARENTNOTIFY` into `Enter` events and wires up validation, so tabbing between VB6 and .NET
  controls behaves. Without this, keyboard navigation across the boundary breaks.
- **Lifetime.** On `WM_DESTROY` the control disposes itself, "to ensure that VB6 will cleanup
  control properly". VB6 and the .NET garbage collector have very different ideas about when an
  object is gone.
- **GUID stability.** The class, interface and event GUIDs are the contract. Change them and every
  compiled VB6 client breaks.
- **Registration drift.** The toolkit's registration-free COM manifest lists nine `clrClass` entries,
  and none of their CLSIDs match the `ClassId` constants in the code. The template even carries a
  reminder — `'TODO: Remember to update InteropUserControl.manifest if you are using RegFree COM` —
  which is exactly the kind of manual synchronization that silently rots.
- **Mixed target frameworks.** The 2014 solution mixes projects targeting .NET 2.0, 3.5, 4.0 and
  4.5. Inside a VB6 process, which CLR actually gets loaded is decided by registration and
  configuration, not by your solution file — something I would pin down very explicitly today.

## Why this approach mattered

What I was really exploring here is what Martin Fowler calls the *strangler fig* pattern:
keep the old shell running, replace pieces at the edges, and let the new system grow inside the old
one until the old one can be retired. Each WPF control dropped onto a VB6 form is a small, reversible
step. If it fails, you take it out again. Nothing forces a big-bang cut-over.

The same thinking also shows in the plug-in experiments: rather than writing more and more
hand-made OCX wrappers, find a stable seam (an interface returning a `UIElement`) and let new UI plug
into it.

## What I'd do today

- **Generate the boring parts.** GUIDs, manifests and wrapper properties are mechanical. Today I would
  generate them from a single source of truth instead of keeping code and manifest in sync by hand.
- **Test the contract, not just the control.** A test that loads the type library and checks the
  exposed members and GUIDs against the expected contract would have caught the manifest drift
  immediately. That idea — encode the rules so the codebase can defend itself — is what my later work
  on architecture and solution tests grew out of.
- **Keep the boundary vocabulary small and explicit.** The wrappers worked best where they translated
  WPF into a deliberately tiny API. That lesson applies to every integration boundary, COM or HTTP.
- **Prefer one generic host over many wrappers.** The `UIElement` plug-in seam was the right instinct.
  One well-tested host with discoverable content scales better than an OCX per control.
