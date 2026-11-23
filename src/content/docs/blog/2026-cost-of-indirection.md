---
title: "The cost of indirection: F12 debugging and benchmarking MediatR against direct calls"
date: 2026-11-23
authors: rene
tags: [cqrs, performance, dotnet]
excerpt: Every abstraction has a price, paid in navigation, debugging and CPU time. What a mediator really costs you, why F12 suddenly lands on a record, the file convention that fixes most of it, and how to measure the runtime overhead yourself with BenchmarkDotNet instead of trusting anyone's numbers.
---


A new developer joins the team, picks a bug, finds the endpoint and presses F12 on the line that does
the work:

```csharp
var result = await sender.Send(new GetOrderSummary(orderId), ct);
```

Visual Studio opens `GetOrderSummary.cs`, which contains a one-line record. Where's the code? They press
F12 on `Send`, end up in MediatR's decompiled source, and give up. Ten minutes later they ask in the team
chat where the logic lives.

That's the most visible cost of a mediator: **indirection**. There's a second cost people worry about,
usually more loudly: runtime overhead. This post looks at both, honestly. The navigation cost is real and
fixable. The runtime cost is real and usually irrelevant, and I'll show you how to measure it yourself
instead of believing a number from a blog post, including this one.

## Cost 1: navigation

With a direct call, the call site points to the implementation:

```csharp
var result = await getOrderSummary.ExecuteAsync(orderId, ct);   // F12 → the method with the logic
```

With a mediator, the call site points to a **message**. The connection between message and handler only
exists at runtime, through DI and reflection. The IDE has no way to know which handler will run.

### The fix: request and handler in the same file

The most effective rule I know is simple: **declare the request and its handler in the same file**, named
after the request.

```csharp
// File: GetOrderSummary.cs
namespace MyShop.Api.Orders.V1;

public sealed record GetOrderSummary(int OrderId) : IRequest<OrderSummary?>;

internal sealed class GetOrderSummaryHandler(ShopDbContext db) : IRequestHandler<GetOrderSummary, OrderSummary?>
{
    public async Task<OrderSummary?> Handle(GetOrderSummary request, CancellationToken ct)
    {
        // the logic is right here, ten lines below where F12 landed
    }
}
```

Now F12 on `new GetOrderSummary(...)` lands in the file that contains the logic. It's not perfect, but it's
one scroll away instead of a search. Two teams I worked with had this as a mandatory rule, and one of them
enforced it with a Roslyn-based architecture test that failed the build if a request and its handler were
in different files.

Other helpers:

- **Go to implementation** (Ctrl+F12 in Visual Studio) on the request type doesn't
  help, because the handler doesn't implement the request. But **Find usages** on the request type shows the
  handler's `Handle` method in the results.
- **Rider** and **ReSharper** have plugins that add navigation from `Send(request)` to the handler.
- A **naming convention** (`XyzHandler` for request `Xyz`) makes "Go to type" work instantly.

### Debugging

Stepping into `Send` with the debugger takes you through MediatR's dispatch code and every pipeline behavior
before you reach your handler. With "Just My Code" enabled (the default), the library frames are skipped, but
your own behaviors are not. Put a breakpoint in the handler instead of stepping. And keep the behaviors few
and simple, because every one of them is in every stack trace:

```text
at MyShop.Api.Orders.V1.GetOrderSummaryHandler.Handle(...)
at MyShop.Api.CachingBehavior`2.Handle(...)
at MyShop.Api.ValidationBehavior`2.Handle(...)
at MyShop.Api.LoggingBehavior`2.Handle(...)
at MediatR.Wrappers.RequestHandlerWrapperImpl`2.Handle(...)
```

That's not bad, as long as it stays readable. It becomes bad when there are eight behaviors and half of
them are generic wrappers around other generic wrappers.

## Cost 2: runtime overhead

What does `Send` do that a direct call doesn't?

1. Look up (and on first use, build and cache) a wrapper for the request type.
2. Resolve the handler from the DI container. Handlers are typically **transient**, so that's a new object
   per request.
3. Resolve the `IEnumerable` of pipeline behaviors, also new objects unless registered as singletons.
4. Build the delegate chain and invoke it.

So there's extra CPU work and extra allocations per request. One team I worked with listed exactly this as
an open question in their guidelines: whether transient handlers cause noticeable extra garbage collection
compared to singleton services. That's the right question. The right answer is to **measure it**, not to
argue about it.

I don't have measured numbers from a source I can share, so I won't make any up. Instead, here's how to get
your own.

## Measuring it with BenchmarkDotNet

Create a console project, reference `BenchmarkDotNet`, `MediatR` and `Microsoft.Extensions.DependencyInjection`,
and compare four variants of the same trivial operation:

```csharp
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;
using MediatR;
using Microsoft.Extensions.DependencyInjection;

BenchmarkRunner.Run<MediatorOverhead>();

public sealed record GetPrice(int ProductId) : IRequest<decimal>;

public sealed class GetPriceHandler : IRequestHandler<GetPrice, decimal>
{
    public Task<decimal> Handle(GetPrice request, CancellationToken ct) => Task.FromResult(request.ProductId * 1.5m);
}

// Three distinct behavior types: registering the same open type three times would be de-duplicated.
public abstract class PassThroughBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken ct) =>
        next(ct);
}

public sealed class BehaviorA<TRequest, TResponse> : PassThroughBehavior<TRequest, TResponse> where TRequest : notnull;
public sealed class BehaviorB<TRequest, TResponse> : PassThroughBehavior<TRequest, TResponse> where TRequest : notnull;
public sealed class BehaviorC<TRequest, TResponse> : PassThroughBehavior<TRequest, TResponse> where TRequest : notnull;

[MemoryDiagnoser]
public class MediatorOverhead
{
    private GetPriceHandler _direct = null!;
    private IServiceProvider _plain = null!;
    private IServiceProvider _withBehaviors = null!;

    [GlobalSetup]
    public void Setup()
    {
        _direct = new GetPriceHandler();

        _plain = new ServiceCollection()
            .AddLogging()
            .AddMediatR(cfg => cfg.RegisterServicesFromAssemblyContaining<GetPrice>())
            .BuildServiceProvider();

        _withBehaviors = new ServiceCollection()
            .AddLogging()
            .AddMediatR(cfg =>
            {
                cfg.RegisterServicesFromAssemblyContaining<GetPrice>();
                cfg.AddOpenBehavior(typeof(BehaviorA<,>));
                cfg.AddOpenBehavior(typeof(BehaviorB<,>));
                cfg.AddOpenBehavior(typeof(BehaviorC<,>));
            })
            .BuildServiceProvider();
    }

    [Benchmark(Baseline = true)]
    public Task<decimal> DirectCall() => _direct.Handle(new GetPrice(42), CancellationToken.None);

    [Benchmark]
    public Task<decimal> ResolveFromContainerAndCall() =>
        _plain.GetRequiredService<IRequestHandler<GetPrice, decimal>>().Handle(new GetPrice(42), CancellationToken.None);

    [Benchmark]
    public Task<decimal> MediatorSend() =>
        _plain.GetRequiredService<ISender>().Send(new GetPrice(42));

    [Benchmark]
    public Task<decimal> MediatorSendWithThreeBehaviors() =>
        _withBehaviors.GetRequiredService<ISender>().Send(new GetPrice(42));
}
```

Run it in Release mode: `dotnet run -c Release`. BenchmarkDotNet warms up, runs enough iterations for stable
results and prints a table.

What to look at:

| Column | What it tells you |
|---|---|
| `Mean` | Average time per call. Compare the variants to the baseline, not to each other's absolute values on other machines. |
| `Ratio` | Relative to `DirectCall`. This is the number to discuss in the team. |
| `Allocated` | Bytes allocated per call. This answers the "transient handlers and GC" question directly. |
| `Gen0` | Garbage collections per 1,000 operations. Non-zero means the variant puts pressure on the GC. |

The `ResolveFromContainerAndCall` variant is important. It separates the cost of **DI resolution** from the
cost of the **mediator** itself. If most of the difference is already there, the mediator isn't the problem;
transient registrations are.

### Put the number in context

A micro-benchmark measures the mediator in isolation, with a handler that does nothing. In a real request,
the handler talks to a database or another service, which takes orders of magnitude longer than any
in-process dispatch. So the second measurement that matters is the **end-to-end** one:

- Run a load test (k6, NBomber, or `bombardier`) against one endpoint implemented both ways and compare
  latency percentiles and throughput.
- Or look at your existing traces: compare the duration of the handler span to the duration of its database
  and HTTP child spans. Whatever is left is your in-process overhead, including the mediator.

If the mediator shows up as a meaningful share of request time, you have an unusual workload (very high
throughput, trivial handlers) and should consider direct calls or a source-generated mediator for those hot
paths. In most business APIs, it won't.

## Cost 3: what you can't see

Two more costs don't show up in benchmarks:

**Hidden dependencies.** A handler that injects `ISender` can send anything. Its constructor no longer tells
you what it depends on. That makes reviews and impact analysis harder.

**Native AOT and trimming.** Reflection-based handler discovery doesn't work well with Native AOT. One team I
worked with chose plain command and query classes over MediatR for exactly that reason, together with the
wish for fewer third-party dependencies. Since v13, MediatR also requires a commercial license for larger
companies, which is another factor to weigh. Source-generated mediators avoid the reflection part.

## Comparison

| | Direct calls | MediatR | Source-generated mediator |
|---|---|---|---|
| F12 to logic | ✅ | ⚠️ with same-file convention | ⚠️ with same-file convention |
| Dependencies visible | ✅ | ❌ hidden behind `ISender` | ❌ hidden behind the mediator |
| Generic pipeline | ⚠️ decorators | ✅ | ✅ |
| Runtime overhead | none | measurable, usually small | small |
| Native AOT | ✅ | limited | ✅ |

## Summary

- The biggest cost of a mediator is **navigation**, not speed. Put **request and handler in the same file**
  and enforce it.
- Debug with **breakpoints in handlers**, keep pipeline behaviors few, and make stack traces readable.
- Runtime overhead consists of DI resolution, allocations and delegate chains. **Measure it with
  BenchmarkDotNet**, including a variant that only resolves from the container, and look at `Allocated`.
- Put micro-benchmark results in context with an **end-to-end** measurement. A database call dwarfs in-process
  dispatch in most APIs.
- Weigh the invisible costs too: hidden dependencies, Native AOT, and licensing.
