---
title: "Lightweight ADRs: write down why, not just what"
date: 2026-11-23
authors: rene
tags: [architecture, api-design, scrum]
excerpt: Two years after a decision, nobody remembers why the team chose it, so the discussion starts again from zero. Architecture decision records fix that with one short Markdown file per decision. The format I use, when a decision deserves one, where to keep them, and a complete example.
---


A new developer asks in a pull request: *"Why do we write all mappers by hand? AutoMapper would save us
half of this code."* A fair question. The senior developer who made that decision left a year ago. Two
people remember "there was a reason, something about performance". The discussion starts again, takes
an afternoon, and ends with the same decision as last time. Or with a different one, made with less
information than the original.

Every long-lived codebase has dozens of decisions like that. The code shows **what** was decided. It
never shows **why**, which alternatives were considered, or what the team knowingly gave up.

**Architecture decision records** (ADRs) are the cheapest fix I know. One short Markdown file per
decision, kept next to the code. This post shows the format I use, when a decision is worth a record,
and a complete example.

## What an ADR is (and isn't)

The idea goes back to a 2011 blog post by Michael Nygard. An ADR is a short document that captures **one**
architecturally significant decision: the context, the decision itself, and its consequences. Once accepted,
it isn't edited. If the decision changes, a new ADR supersedes the old one.

It's **not** a design document, a specification or a wiki page that describes the current state of the
system. It's a log entry. The collection of ADRs is the history of how the architecture got to where it is.

## The format

I've seen teams start with elaborate templates and give up after three records. The format that survives
is short. Mine has six sections:

```markdown
# ADR-0007: Hand-written mappers instead of a mapping library

- **Status:** Accepted
- **Date:** 2026-03-14
- **Deciders:** Backend team

## Context

What is the problem? What forces are at play (technical, organizational, cost,
time)? What do we know, and what don't we know yet? Two to five paragraphs.

## Options considered

### Option A: ...
Pros / cons as a short list.

### Option B: ...
Pros / cons as a short list.

## Decision

The option we chose, in one or two sentences. "We will ..."

## Consequences

What becomes easier, what becomes harder, what we have to do now, what we
accept as a downside. Include the follow-up work.

## Links

Pull requests, issues, benchmarks, related ADRs.
```

A few remarks on the sections:

- **Status** is one of *Proposed*, *Accepted*, *Rejected*, *Deprecated* or *Superseded by ADR-00xx*. A
  *Proposed* ADR is a perfectly good way to start a discussion. I've seen ADRs that sat at "work in progress,
  gathering information" for weeks, and that was useful: everyone knew the question was open and where the
  current thinking was.
- **Options considered** with pros and cons is the most valuable part. It's what stops the same discussion
  from being repeated, because the rejected option and the reason are right there. Nygard's original format
  doesn't have this section; the MADR template does, and I find it essential.
- **Decision** names who decided and when. Not to assign blame, but because "the team agreed in the
  architecture meeting" carries different weight than "one developer chose this on a Friday".
- **Consequences** must include the negatives. An ADR that only lists benefits is a sales pitch, and nobody
  will trust it later.

## When to write one

Not every decision needs a record. My rule: **write an ADR when the decision is hard to reverse, affects more
than one team or component, or is likely to be questioned later.**

Typical triggers:

- Choosing or dropping a framework or library (mediator, ORM, mapping, validation, test framework).
- Licensing changes of a dependency you rely on.
- Structural conventions: folder structure, versioning strategy, how endpoints are built.
- Integration decisions: synchronous API vs. events, which system owns which data.
- Deliberately *not* doing something everyone expects (no MediatR, no microservices, no caching here).
- Trade-offs with a known downside: "we accept eventual consistency between X and Y".

Not worth a record: naming of a private method, the choice between two equivalent LINQ styles, anything
an analyzer or `.editorconfig` already enforces.

A helpful signal: if a pull request discussion gets longer than about ten comments about *approach* rather
than *code*, the outcome probably deserves an ADR.

## Where to keep them

**In the repository, next to the code.** I use `docs/adr/` with numbered files:

```text
docs/
└── adr/
    ├── 0001-record-architecture-decisions.md
    ├── 0002-feature-and-action-folder-structure.md
    ├── 0003-shared-contracts-package.md
    ├── ...
    └── 0007-hand-written-mappers.md
```

Reasons:

- ADRs are reviewed in pull requests, like code. Proposing a decision **is** opening a PR.
- They're versioned with the code they describe. Check out an old commit, and you see the decisions that
  were valid then.
- They're found by the same search developers already use.

A wiki works too, and I've seen teams keep ADRs there successfully, especially when product owners and
architects outside the development team contribute. What matters is one agreed place and an index page that
lists all records with their status.

The first ADR is traditionally "We will record architecture decisions", which explains the format to
everyone who joins later. Tools like `adr-tools` or Log4brains can create numbered files and render an
overview site, but a template file and a naming convention are enough to start.

## A complete example

Here's an ADR in full, for a fictional shop backend. The details are invented for the example; the shape is
what matters. It's short on purpose: most good ADRs fit on one screen.

```markdown
# ADR-0007: Hand-written mappers instead of a mapping library

- **Status:** Accepted
- **Date:** 2026-03-14
- **Deciders:** Backend team (architecture meeting)

## Context

The shop API maps between three models per domain: API contracts, internal
domain models and database entities (see ADR-0003). Each endpoint has one or two
mappers. Today about 40 mappers exist, most of them written by hand, a few using
a reflection-based mapping library.

We plan to evaluate Native AOT for the API in the next year. Reflection-heavy
libraries are a risk for that. The mapping library we use moved to a commercial
license for companies of our size. Debugging the library-based mappers has
cost us time twice this quarter, because a missing property caused silent data
loss that only showed up in production.

## Options considered

### Option A: Keep the reflection-based mapping library
- ➕ Least code per mapper
- ➖ Mapping errors only surface at runtime
- ➖ Not compatible with Native AOT without extra work
- ➖ License cost and procurement process

### Option B: Source-generated mapping (e.g. Mapperly)
- ➕ No reflection, AOT friendly
- ➕ Unmapped properties can fail the build
- ➖ New dependency to learn; generated code is less familiar
- ➖ Complex conversions still need manual code

### Option C: Hand-written mappers
- ➕ Fully explicit and debuggable, no dependency
- ➕ AOT friendly
- ➖ More code to write
- ➖ Forgotten properties must be caught by tests

## Decision

We write mappers by hand (Option C). For domains with more than ~20 mapped
properties per type, teams may use source-generated mapping (Option B) after
a short discussion. We remove the reflection-based library by the end of Q2.

## Consequences

- Every mapper gets a test that checks all target properties are mapped.
  A shared test helper will be provided.
- The existing library-based mappers are migrated as part of normal feature
  work; a tracking issue lists the remaining ones.
- Mapper code volume grows. We accept that in exchange for explicitness.
- If Native AOT is ruled out later, this decision stays valid for the
  debugging and licensing reasons and does not need revisiting.

## Links

- ADR-0003: Shared contracts package
- Blog post: Mapping as an anti-corruption layer
```

Notice what this record does for the developer from the introduction: they find it with one search, see that
the library was considered, see three concrete reasons it was dropped, and see under which condition a
generator is allowed. The afternoon discussion becomes a five-minute read.

## Lightweight vs. heavyweight

| | No records | Lightweight ADRs | Full architecture documentation |
|---|---|---|---|
| Effort per decision | none | 15–30 minutes | hours to days |
| Captures *why* | ❌ | ✅ | ⚠️ often only *what* |
| Stays up to date | n/a | ✅ immutable, superseded when needed | ❌ drifts from the code |
| Onboarding value | ❌ | ✅ history in one folder | ✅ if current |
| Survives team changes | ❌ | ✅ | ⚠️ |

ADRs don't replace a high-level architecture overview. A short README with a context diagram is still useful.
But for capturing decisions, nothing I've tried beats one Markdown file per decision.

## Pitfalls

**Writing them after the fact, months later.** The context is gone by then, and the record becomes a
justification instead of a decision log. Write the ADR while deciding, as a *Proposed* record, and accept it
when the team agrees.

**Editing accepted ADRs.** If the decision changes, write a new ADR and mark the old one *Superseded by
ADR-00xx*. The history is the point.

**Too long.** If an ADR needs five pages, it's probably several decisions, or a design document. Split it.

**Only positives.** Every real decision has a downside. Write it down, or the next reader will assume nobody
thought about it.

**No index.** Twenty files without an overview are hard to use. Keep a `README.md` in `docs/adr/` with number,
title and status, or let a tool generate it.

**Customer or team internals in ADRs that get shared.** ADRs often mention people, systems and contracts. If
your records might be shown outside the team, keep personal names out and refer to roles instead.

## Make it a habit

Two small things keep ADRs alive:

- **A pull request template** with a checkbox: *"Does this change need an ADR or supersede one?"* It costs
  nothing and prompts the question at the right moment.
- **Link ADRs from code** where the decision is visible: a one-line comment like
  `// Hand-written on purpose, see docs/adr/0007-hand-written-mappers.md` next to the first mapper of a project
  answers the question before it's asked.

Some teams also link ADRs from architecture tests: the failure message of a rule points to the ADR that
explains it. That turns a failing build into documentation, which is what
[self-defending codebases](/blog/2026-self-defending-codebases/) are about.

## Summary

- An ADR captures **one decision**: context, options with pros and cons, the decision, and its consequences.
- Write one when a decision is **hard to reverse, crosses team boundaries, or will be questioned later**.
- Keep ADRs **in the repository**, numbered, reviewed in pull requests, with an index.
- Don't edit accepted records; **supersede** them. Always include the **downsides**.
- Keep them short. A record that fits on one screen is a record people actually read.
