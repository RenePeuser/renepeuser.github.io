---
title: Interactive canvases in WPF — drawing, zooming, drag & drop, touch keyboards
date: 2013-06-27
authors: rene
tags: [retrospective, wpf, ui, touch]
excerpt: Industrial panels have no mouse and often no keyboard, but operators still have to draw, zoom, drag and type. In 2013 I collected the WPF techniques that make that possible, and built a touch keyboard that legacy VB6 screens could call through COM.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2013. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

Office software assumes a mouse, a keyboard and a desk. A machine panel has none of those: a touch screen, maybe gloves, and an operator standing up. Around 2013, as the UIs I worked on became more CAD-like (layouts you can see, zoom and rearrange), I collected the WPF building blocks for that kind of interaction.

My archive from that time mixes my own code with reference samples I downloaded to learn from. I'll be clear about which is which, because a retrospective that takes credit for someone else's sample isn't worth much.

## Typing without a keyboard: a touch keyboard for VB6 screens

The most practical piece came first. The [OnScreenKeyboard_VB6](https://github.com/RenePeuser/OnScreenKeyboard_VB6) repository isn't VB6 code, despite the name. It's a C# WPF keyboard *for* VB6. Many existing HMI screens were still VB6, and they needed a touch-friendly input dialog. Rewriting them wasn't an option, so the WPF dialog was exposed as a COM component that VB6 could call like any other object (the same interop path I describe in [Hosting WPF controls in VB6](/blog/2012-hosting-wpf-controls-in-vb6/)).

The COM contract was deliberately tiny:

```csharp
[Guid("2ED93A49-C528-4A74-B6F5-3423DA97E012")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
[ComVisible(true)]
public interface IOnScreenKeyboard_VB6
{
    // Detail method: tells the operator which field is being edited
    string ShowKeyboardDetail(string control, string controlDescription, string text, int keyboardType);

    // Must stay, so this version remains backward compatible when extended
    string ShowKeyboard(string text, int keyboardType);
}
```

That second comment (translated from German) is the important line. Once a VB6 client is compiled against an `IDispatch` interface, you don't break it. New capabilities get a new method, and the old one stays.

Behind the interface, the implementation picks a full keyboard or a numeric keypad, shows it modally and returns the edited text:

```csharp
private string ShowOnScreenKeyboard(string controlName, string controlDescription, string text, int keyboardType)
{
    var viewModel = new KeyboardViewModel(controlName, controlDescription, text);
    Window onScreenKeyboard;

    switch (keyboardType)
    {
        case 1:
            onScreenKeyboard = new Numpad { DataContext = viewModel };
            break;
        default:
            onScreenKeyboard = new Keyboard { DataContext = viewModel };
            break;
    }

    onScreenKeyboard.ShowDialog();
    return viewModel.UserText;
}
```

The keys themselves came from an open-source WPF keyboard control. My part was the integration and the operator experience. The dialogs scale with the screen (`Height = 50%`, `Width = 75%` of the primary screen), use a 28 pt text box, and show *which* field is being edited, using the name and description passed in from VB6. The numeric pad only commits on **OK**:

```xml
<TextBox Text="{Binding Path=UserText, UpdateSourceTrigger=Explicit}" FontSize="28" />
```

```csharp
if (e.OnScreenKey.Key.DisplayName == "OK")
{
    _textBox.GetBindingExpression(TextBox.TextProperty).UpdateSource();
    Close();
}
```

`UpdateSourceTrigger=Explicit` is a small detail that matters on a machine. If the operator closes the dialog any other way, the original value stays. A half-typed number never reaches the machine.

### How a screen used it

The project targets .NET 2.0 and sets `RegisterForComInterop` to `true`, so a build registers the class under its default ProgID, `OnScreenKeyboard_VB6.OnScreenKeyboard_Vb6`. To check the dialog without a VB6 machine, the repository has a small WPF test window that calls it through the same interface a COM client sees:

```csharp
void _textbox_MouseDoubleClick(object sender, MouseButtonEventArgs e)
{
    OnScreenKeyboard_VB6.IOnScreenKeyboard_VB6 test = new OnScreenKeyboard_Vb6();
    _textbox.Text = test.ShowKeyboardDetail("", "", _textbox.Text, 1);
}
```

On the VB6 side, it took one late-bound call per input field. The archive doesn't contain the VB6 screens, so this is a reconstruction of the pattern, not original code:

```vb
' Reconstruction: double-tap a text box to edit it on the numeric pad
Private Sub txtFeedRate_DblClick()
    Dim keyboard As Object
    Set keyboard = CreateObject("OnScreenKeyboard_VB6.OnScreenKeyboard_Vb6")

    txtFeedRate.Text = keyboard.ShowKeyboardDetail( _
        "txtFeedRate", "Feed rate (mm/min)", txtFeedRate.Text, 1)
End Sub
```

Because the dialog returns the original text on cancel, the VB6 code needs no special case. It always writes back whatever comes out.

## Moving shapes: a naive first step

[MVVM_Drawing](https://github.com/RenePeuser/MVVM_Drawing) shows where I started on the canvas itself. The name says MVVM, but the code is honest about being day one: a `ShapeLine` model with `Start` and `End` points, and a code-behind experiment that moves a `Polyline` across a `Canvas` from a background thread:

```csharp
var animationThread = new Thread(() =>
{
    while (left < 300)
    {
        left += 10;
        Dispatcher.Invoke(new Action(() => Canvas.SetLeft(myPolyline, left)));
        Thread.Sleep(50);
    }
});
animationThread.Start();
```

It works, and it taught me the main rule of WPF threading: every UI change goes through the `Dispatcher`. But it's the wrong tool. A `DoubleAnimation` on `Canvas.Left`, or `CompositionTarget.Rendering` for frame-based updates, does the same thing without a thread that sleeps.

## Zoom and pan: learning from ZoomableCanvas

For zooming I studied a published ZoomableCanvas tutorial, and that sample is in my archive. Two ideas from it stayed with me.

First, **spatial virtualization**. The items source implements a `Query(Rect)` method, so the panel only creates containers for items that intersect the visible area. A slider pushes the count up to a million items, and the UI stays responsive.

The XAML in my copy of the sample ([ZoomableApplication2](https://github.com/RenePeuser/ZoomableApplication2)) shows how little the view has to know. A plain `ListBox` gets the canvas as its items panel, and each item container is positioned by binding:

```xml
<ListBox x:Name="MyListBox">
    <ListBox.ItemsPanel>
        <ItemsPanelTemplate>
            <ZoomableCanvas Loaded="ZoomableCanvas_Loaded"
                            RealizationLimit="1000"
                            RealizationRate="10"
                            RealizationPriority="Background"/>
        </ItemsPanelTemplate>
    </ListBox.ItemsPanel>

    <ListBox.ItemContainerStyle>
        <Style TargetType="ListBoxItem">
            <Setter Property="Canvas.Top" Value="{Binding top}"/>
            <Setter Property="Canvas.Left" Value="{Binding left}"/>
            <Setter Property="Width" Value="{Binding width}"/>
            <Setter Property="Height" Value="{Binding height}"/>
        </Style>
    </ListBox.ItemContainerStyle>
</ListBox>
```

`RealizationLimit` caps how many containers exist at once, and `RealizationRate` with `RealizationPriority="Background"` creates them in small batches at low priority. While you scroll quickly, the UI keeps responding to input and fills in items as it catches up. Selection, keyboard navigation and styling still come from the `ListBox` for free.

Second, **zooming around the cursor**. Scaling alone makes the content jump away from where you're pointing. The fix is to adjust the offset so the point under the mouse stays put:

```csharp
var x = Math.Pow(2, e.Delta / 3.0 / Mouse.MouseWheelDeltaForOneLine);
MyCanvas.Scale *= x;

var position = (Vector)e.GetPosition(MyListBox);
MyCanvas.Offset = (Point)((Vector)(MyCanvas.Offset + position) * x - position);
```

That one line of vector maths is the difference between a zoom that feels right and one that annoys you every time you use it.

## Drag & drop that scrolls

Another reference sample in the archive solves a classic touch and mouse annoyance: dragging an item to a spot that's currently scrolled out of view. It's an attached property, `ScrollOnDragDrop="True"`, that hooks `PreviewDragOver`, finds the first `ScrollViewer` inside the control, and scrolls when the pointer gets near the top or bottom edge. The sensitive zone is `Math.Min(40, ActualHeight * 0.25)`, and the scroll speed increases the closer you get to the edge.

Using it is one attribute on any drop target that contains a `ScrollViewer`, from the demo window in [Wpf_Drag_Drop_Scroll](https://github.com/RenePeuser/Wpf_Drag_Drop_Scroll):

```xml
<ListBox AllowDrop="True"
         dde:DragDropExtension.ScrollOnDragDrop="True" />
```

That isn't my code, but the *shape* of the solution influenced a lot of what I wrote afterwards: behaviour packaged as an attached property, switched on in XAML, with no code-behind in the view that uses it.

## When there are thousands of shapes: DrawingVisual

Every `Shape` in WPF is a full `FrameworkElement`, with layout, input and styling. That's fine for dozens of elements and expensive for thousands. [DrawingVisuals](https://github.com/RenePeuser/DrawingVisuals) is my measurement of the alternative. It starts from the documented "visual host" pattern and adds a benchmark: three hosts, each filled with 1,000 lines or rectangles, timed with a `Stopwatch`.

The pattern itself is short. Render everything into one `DrawingVisual`, own it through a `VisualCollection`, and tell WPF about it:

```csharp
private DrawingVisual CreateDrawingVisualRectangle(int uiElements, bool drawLines)
{
    DrawingVisual drawingVisual = new DrawingVisual();
    DrawingContext drawingContext = drawingVisual.RenderOpen();

    for (int i = 0; i < uiElements; i++)
    {
        // ... compute row/col, then either two lines or:
        Rect rect = new Rect(new Point(col * height + 10, row * width + 10), new Size(height, width));
        drawingContext.DrawRectangle(Brushes.LightBlue, null, rect);
    }

    drawingContext.Close();
    return drawingVisual;
}

protected override int VisualChildrenCount
{
    get { return _children.Count; }
}

protected override Visual GetVisualChild(int index)
{
    return _children[index];
}
```

Hit testing then goes through `VisualTreeHelper.HitTest` with a callback instead of per-element mouse events.

### Reading my old benchmark critically

Here is the measurement from 2013, unchanged:

```csharp
private void Button_Click(object sender, RoutedEventArgs e)
{
    stopwatch.Start();
    this.drawingContainer1.CreateUIElements(1000, true);
    this.drawingContainer2.CreateUIElements(1000, false);
    this.drawingContainer3.CreateUIElements(1000, true);
    stopwatch.Stop();
    MessageBox.Show("Time elapsed in milisekonds: " + stopwatch.Elapsed.Milliseconds.ToString());
    stopwatch.Reset();
}
```

It has four problems:

- `Elapsed.Milliseconds` is only the millisecond *component* of the elapsed time. At 1.2 seconds it would show 200. `TotalMilliseconds` is the value you want.
- The first click includes JIT compilation and cold caches. There's no warm-up and only one run.
- It stops the clock before WPF has done any layout or rendering. It measures how fast you can *record* drawing instructions, not how long the operator waits for pixels.
- There's nothing to compare against. All three hosts use `DrawingVisual`, so the benchmark never measures the `Shape` version it was supposed to replace.

Inside `CreateDrawingVisualRectangle` there's a fifth, smaller problem: `blackPen.Freeze()` is called on every loop iteration, and `redPen` is never frozen. An unfrozen `Freezable` has to be watched for changes, and that costs time.

### Measuring it properly (2026 rewrite)

To find out whether the conclusion still holds, I rewrote the benchmark for this post. This code is new and not part of the archive. It compares the same N rectangles as `Rectangle` shapes on a `Canvas` and as one `DrawingVisual`. It uses frozen brushes and pens, does three warm-up runs, takes the median of ten, and stops the clock only after the dispatcher has processed layout and the render pass:

```csharp
static readonly Brush Fill = Freeze(new SolidColorBrush(Colors.LightBlue));
static readonly Pen Outline = Freeze(new Pen(Brushes.Black, 1));

static async Task<(double build, double total)> Measure(Grid host, Func<int, FrameworkElement> build, int n)
{
    host.Children.Clear();
    await Dispatcher.CurrentDispatcher.InvokeAsync(() => { }, DispatcherPriority.ContextIdle);
    GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();

    var sw = Stopwatch.StartNew();
    var element = build(n);                       // create shapes or record the drawing
    var buildMs = sw.Elapsed.TotalMilliseconds;   // TotalMilliseconds, not Milliseconds
    host.Children.Add(element);

    // ContextIdle runs after Loaded and Render, so layout and the
    // UI thread's render pass are included in the second number.
    await Dispatcher.CurrentDispatcher.InvokeAsync(() => { }, DispatcherPriority.ContextIdle);
    return (buildMs, sw.Elapsed.TotalMilliseconds);
}

static FrameworkElement BuildVisual(int n)
{
    var visual = new DrawingVisual();
    using (var dc = visual.RenderOpen())
        for (int i = 0; i < n; i++)
            dc.DrawRectangle(Fill, Outline, new Rect(i % 100 * 11, i / 100 * 11 % 880, 10, 10));
    return new VisualHost(visual);                // FrameworkElement with a VisualCollection
}
```

`BuildShapes` creates the same rectangles as `Rectangle` elements with `Canvas.SetLeft` and `Canvas.SetTop`. On my machine (.NET 10, WPF, median of ten runs after three warm-ups), the result looked like this:

| Rectangles | `Shape`s: build | `Shape`s: until rendered | `DrawingVisual`: build | `DrawingVisual`: until rendered |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 3.6 ms | 13.5 ms | 0.4 ms | 1.2 ms |
| 10,000 | 17–31 ms | 106–124 ms | 0.8–1.6 ms | 4.4–8.5 ms |
| 50,000 | 75–79 ms | 379–390 ms | 3.1–3.3 ms | 13.7–14.4 ms |

The ranges come from two separate runs. The 2013 conclusion holds, and the gap is bigger than the old numbers suggested. At 1,000 rectangles, `DrawingVisual` is about ten times faster until the frame is ready. At 50,000, it's more than 25 times faster. Most of the cost for shapes isn't creating them but layout and rendering, which is exactly the part the old benchmark didn't measure.

One caveat: `ContextIdle` covers work on the UI thread. Composition on WPF's separate render thread and the GPU isn't in these numbers. For a canvas that is redrawn while the operator watches, the UI thread is the part that decides whether input feels sluggish, so that's the right thing to measure here.

## A grid to align against

A small helper from later, [GirdToAlignControls](https://github.com/RenePeuser/GirdToAlignControls) (2017, typo included), belongs here because it uses the same "cheap drawing" idea. Instead of hundreds of line elements, the alignment grid is a single tiled, frozen `DrawingBrush` set as the panel background through an attached property:

```csharp
var size = (Size)frameworkElement.GetValue(GridSizeProperty);
var pen = new Pen(Brushes.DarkGray, 0.1);
pen.Freeze();

var brush = new DrawingBrush();
brush.Drawing = new GeometryDrawing(null, pen, new RectangleGeometry(new Rect(size)));

// Set Viewport and TileMode
brush.Viewport = new Rect(size);
brush.ViewportUnits = BrushMappingMode.Absolute;
brush.TileMode = TileMode.Tile;
brush.Freeze();

panel.Background = brush;
```

```xml
<Canvas local:AttachedPropertiesForFrameworkElement.ShowGrid="True"
        local:AttachedPropertiesForFrameworkElement.GridSize="10,10" />
```

The archive also holds an open-source WPF property grid I studied for editing the properties of a selected object, and, much later (2019), a `Viewport3D` experiment with an imported mesh. That's a different kind of canvas, but driven by the same curiosity.

## Lessons that stuck

- **Design for the panel, not the desk.** Large fonts, dialogs sized relative to the screen, explicit commit and cancel, and context ("which field am I editing?") matter more on a machine than any visual polish.
- **Never break a COM contract.** Add methods, don't change them. The VB6 client on the other side won't recompile itself.
- **Pick the right weight of element.** Use `Shape`s for a handful of interactive things, `DrawingVisual`s or brushes for thousands of passive ones.
- **Package behaviour as attached properties.** Auto-scroll, grids and zoom are things a view should switch on in XAML, not reimplement in code-behind.
- **Measure properly or not at all.** `TotalMilliseconds`, warm-up runs, a baseline to compare against, and including the render pass. My 2013 self skipped all four, and was still right only by luck.

What I'd do today: keep the canvas model pure (shapes as plain view-model objects with geometry), render through a single custom element that draws them, and do zoom and pan with one `MatrixTransform` instead of moving each item. The interaction logic would sit in testable classes rather than in mouse event handlers.
