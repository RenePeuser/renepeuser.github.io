---
title: Where it started — VB6 user interfaces next to the machine
date: 2007-06-01
authors: rene
tags: [retrospective, vb6, hmi, industrial]
excerpt: Before WPF, MVVM or test SDKs, I wrote operator interfaces in VB6 for industrial machines. That is where I learned that a software defect is not a ticket, it is a stopped machine.
---

:::note[Retrospective]
Written in 2026, looking back at work from 2007. Part of the series [*From VB6 to self-defending codebases*](/series/from-vb6-to-self-defending-codebases/).
:::

Most of my career has been about software architecture, frameworks and testing. But it did not start
in an IDE. It started next to machines.

## From electronics to software

I trained in industrial electronics around 1998. What followed was hands-on industrial work: PLC
programming, servo drives, process control, machine commissioning, troubleshooting and customer
training. Somewhere in that mix, user interfaces became part of the job, and at that time, in that
environment, user interfaces meant **Visual Basic 6**.

The original HMI code from those years is not part of my public archive, so this post stays general.
What I can describe is what the work taught me, because those lessons outlived the technology by a
long way.

## A defect can stop a machine

In office software, a bug is often an annoyance. Next to a machine, the same class of bug looks very
different. A wrong value on a screen, a button that does not react, a dialog that blocks at the wrong
moment: any of these can stop production.

That changes how you think about quality. Software quality is not an abstract metric. It is
operational reality, measured by whether the machine keeps running.

:::tip[The lesson that stuck]
If you cannot be sure a change is safe, you do not ship it to a running machine. Much of what I built
later, from automated UI tests to architecture checks, is an attempt to make "being sure" cheaper.
:::

## Operators are real users

The people using an HMI are not developers and usually not office workers either. They are operators
and service technicians who need to understand the state of a machine quickly, often under pressure.

Building screens for them taught me a few things early:

- **Clarity beats cleverness.** An operator needs to see what is happening and what to do next.
- **Consistency matters.** The same action should look and behave the same everywhere.
- **The UI is part of the machine.** If the interface misleads, the machine is effectively wrong.

## Commissioning as a feedback loop

Commissioning is where software meets reality. You find out whether the assumptions in your code match
the physical machine, the wiring, the drives and the process. Problems surface on site, and they have
to be understood and fixed there.

That gave me a habit I still rely on: trace a problem through every layer, from the screen down to the
hardware and back, instead of stopping at the first plausible explanation.

## Where VB6 reached its limits

VB6 was productive for building forms quickly, and for many years it did its job. But as user
interfaces grew, its limits became harder to ignore:

- Reuse was mostly copy and paste; there was no real inheritance to build shared UI building blocks.
- Customizing the look of standard controls was difficult, so a modern, consistent visual language was
  hard to achieve.
- Separating UI logic from presentation relied entirely on discipline, not on the platform.
- Testing UI behavior in an automated way was practically out of reach.

Those limits are what pulled me towards .NET. Around 2007 and 2008 I moved into C# and WPF, with its
data binding, styles and templates, and a platform that finally supported separating *what* the UI
shows from *how* it is shown.

And because large VB6 applications do not disappear overnight, a few years later I spent a lot of time
on the question of how to bring WPF *into* existing VB6 user interfaces. That story gets its own post.

## Lessons that stuck

- Software quality is measured where the software runs, not where it is written.
- Users who work under pressure deserve interfaces that are obvious and consistent.
- When a platform makes the right structure hard, people stop using the right structure. The platform
  matters.
- Debugging across layers is a skill worth keeping, even when the layers are now HTTP, containers and
  cloud services instead of drives and PLCs.
