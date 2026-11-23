---
title: Consistent formatting locally and in CI — when IDE0055 fails only on the build agent
date: 2026-11-23
authors: rene
tags: [dotnet, code-quality, devops, tooling]
excerpt: The build is clean on every Windows laptop and fails on the Linux agent with hundreds of IDE0055 "fix formatting" errors. Line endings, byte order marks and IDE formatters that don't agree with Roslyn. How .editorconfig, .gitattributes and dotnet format give you one formatting truth across machines.
---

:::note[Series]
Part of the series [*Code quality & tooling*](/series/code-quality-and-tooling/).
:::

In one codebase I worked on, the CI pipeline (Linux, .NET 9) started failing with `IDE0055: Fix formatting`
in hundreds of places. Locally, every developer had a clean build. Visual Studio showed no warnings, Rider was
happy, and `git diff` showed nothing. The code was "correctly formatted" everywhere except on the one machine that
actually decides whether a PR can be merged.

Formatting seems like the most trivial quality topic there is. That's exactly why it's so annoying when it breaks:
nobody wants to spend an afternoon on whitespace. The fix is a one-time setup, and afterwards formatting is
something nobody has to think about again.

## Why local and CI disagree

The mismatch came from four differences between the developer machines and the build agent:

| Cause | What happens |
|---|---|
| **CRLF vs. LF** | Windows checkouts had CRLF line endings, the Linux agent LF. Roslyn's formatting check compares against the configured `end_of_line`, so the same file passes on one machine and fails on the other. |
| **UTF-8 with BOM vs. without** | Some files had a byte order mark, others didn't. With a `charset` rule in place, the inconsistent ones are flagged. |
| **Different formatters** | Rider uses its own formatting engine, Visual Studio uses Roslyn. Code that Rider considers formatted isn't necessarily formatted for Roslyn's `IDE0055`. |
| **Strictness only in CI** | Locally, formatting findings were suggestions. CI ran `dotnet format --verify-no-changes`, which fails on any difference. |

None of these is a bug. They're all the result of each tool doing what it's configured to do, with no shared
configuration.

## The solution: one source of truth in the repository

Three files and one command:

1. **`.editorconfig`** defines how code should look, for every IDE and for `dotnet format`.
2. **`.gitattributes`** makes git store and check out files with consistent line endings.
3. **`dotnet format`** applies and verifies the rules, locally and in CI.

### .editorconfig

The parts that matter for cross-platform consistency come first:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 4

[*.{json,yml,yaml,xml,csproj,props,targets}]
indent_size = 2

[*.cs]
# Formatting violations fail the build
dotnet_diagnostic.IDE0055.severity = error

# C# formatting preferences
csharp_new_line_before_open_brace = all
csharp_indent_case_contents = true
csharp_space_after_keywords_in_control_flow_statements = true
csharp_prefer_braces = true
csharp_style_namespace_declarations = file_scoped
csharp_using_directive_placement = outside_namespace
dotnet_sort_system_directives_first = true

# Severities via dotnet_diagnostic: the "option = value:warning" shorthand is ignored by the build
dotnet_diagnostic.IDE0011.severity = warning   # braces
dotnet_diagnostic.IDE0161.severity = warning   # file-scoped namespaces
dotnet_diagnostic.IDE0065.severity = warning   # using placement

# Generated code is not ours to format
[**/Migrations/*.cs]
generated_code = true
```

`charset = utf-8` means UTF-8 *without* BOM. That's the choice I'd make for any repository built on Linux agents.
Visual Studio is fine with it, and nothing else trips over invisible bytes at the start of a file.

Together with `EnforceCodeStyleInBuild` in your
[Directory.Build.props](/blog/2026-directory-build-props/), the `IDE0055` severity makes formatting part of the
normal build, so you see it in the IDE as you type instead of only in CI.

### .gitattributes: the part most teams miss

`.editorconfig` tells editors to write LF. It doesn't control what **git** does. On Windows, git is often installed
with `core.autocrlf=true`, which converts LF to CRLF on checkout. The result: `.editorconfig` says LF, the files on
disk say CRLF, and the formatting check fails locally or in CI depending on the machine.

`.gitattributes` overrides the per-machine git setting for everyone:

```text
# Normalize all text files to LF in the repository and on checkout
* text=auto eol=lf

# Windows-only scripts keep CRLF
*.cmd text eol=crlf
*.bat text eol=crlf

# Binary files are never touched
*.png binary
*.dll binary
```

After adding it, re-normalize the files that are already in the repository once:

```bash
git add --renormalize .
git commit -m "Normalize line endings to LF"
```

## The big reformatting commit

Once the configuration is in place, run the formatter over the whole solution:

```bash
dotnet format MyShop.sln
```

The first run produces a large, whitespace-only diff. That's expected. Do it in a dedicated PR with nothing else in
it, merge it quickly (it conflicts with everything), and ask the team to rebase afterwards.

To keep `git blame` useful, add the commit to a `.git-blame-ignore-revs` file:

```text
# .git-blame-ignore-revs
# Normalize line endings and apply dotnet format
3f9c2e1a7d...
```

GitHub picks this file up automatically in its blame view. Locally, `git config blame.ignoreRevsFile
.git-blame-ignore-revs` does the same.

## Make every IDE follow the same rules

- **Visual Studio** reads `.editorconfig` by default. Make sure "Use .editorconfig settings" isn't disabled under
  Tools → Options → Text Editor → Code Style.
- **Rider** has EditorConfig support under Settings → Editor → Code Style. Enable it, and make sure it overrides the
  IDE's own settings. Rider's formatter still isn't Roslyn, so for edge cases `dotnet format` is the referee.
- **VS Code** with C# Dev Kit uses Roslyn and reads `.editorconfig`.

Format on save is a nice convenience, but don't rely on it. Not everyone enables it, and not every tool that touches
code (including AI agents) runs it.

## The CI step

```yaml
- name: Verify formatting
  run: dotnet format MyShop.sln --verify-no-changes --verbosity diagnostic
```

`--verify-no-changes` fails with a non-zero exit code if any file would change, and lists the files and rules
involved. Run it **before** the build and tests, because it's fast and the most common reason for a red PR.

For large solutions, `dotnet format` can take a while. Two options: run only the whitespace check
(`dotnet format whitespace --verify-no-changes`), which doesn't need a full compilation, or restrict the check to
files changed in the PR with `--include`.

### Catching it before the push

A pre-commit hook gives the fastest feedback. A plain git hook works, or a tool like Husky.Net if you want it to be
installed automatically on `dotnet tool restore`:

```bash
#!/bin/sh
# .githooks/pre-commit: check only staged C# files
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.cs')
[ -z "$files" ] && exit 0
dotnet format MyShop.sln --verify-no-changes --include $files || {
  echo "Formatting issues found. Run 'dotnet format' and stage the changes."
  exit 1
}
```

Hooks are optional and can be skipped, so the CI step stays the source of truth.

## Formatting approaches compared

| | IDE settings only | `.editorconfig` + IDE | `.editorconfig` + `dotnet format` in CI | CSharpier |
|---|---|---|---|---|
| Same result for every developer | ❌ | mostly | ✅ | ✅ |
| Enforced in CI | ❌ | ❌ | ✅ | ✅ (`csharpier check`) |
| Configurable style | ✅ | ✅ | ✅ | ❌ deliberately opinionated |
| Covers code style beyond whitespace | partly | ✅ | ✅ (`style`, `analyzers` subcommands) | ❌ whitespace and layout only |
| Line endings and encoding | ❌ | ✅ | ✅ (with `.gitattributes`) | partly |

[CSharpier](https://csharpier.com/) is worth a look if your team is tired of discussing style: like Prettier, it
formats everything one way, with almost no options. It doesn't replace `.editorconfig` for analyzer severities and
code-style rules, though, and mixing it with Roslyn's `IDE0055` means you need to decide which formatter is in charge.

## Pitfalls

**`.gitattributes` without re-normalizing.** Adding the file only affects files git touches from now on. Without
`git add --renormalize .`, existing files keep their old line endings in the repository.

**Generated code in the check.** EF Core migrations, gRPC stubs and other generated files shouldn't fail a formatting
check. Mark them with `generated_code = true` or exclude their folders.

**Different SDK versions.** `dotnet format` ships with the SDK, and its rules can change between versions. Pin the SDK
with `global.json` so local runs and CI use the same formatter.

**Formatting rules as `suggestion` locally, `error` in CI.** That's exactly the situation from the beginning. Use the
same severity everywhere. That's what having it in `.editorconfig` is for.

**Using formatting as a review topic.** Once the tooling enforces it, whitespace comments in code reviews should stop.
If a reviewer wants a different rule, it's a PR to `.editorconfig`, not a comment on someone's code. More on what
reviews should and shouldn't cover in the [code review checklist](/blog/2026-code-review-checklist/).

## Summary

- "Clean locally, failing in CI" formatting errors come from **line endings, BOMs, different formatters and different
  strictness**.
- Put the rules in **`.editorconfig`**: UTF-8 without BOM, LF, and `IDE0055` as an error.
- Add **`.gitattributes`** with `* text=auto eol=lf` and re-normalize once. `.editorconfig` alone doesn't control git.
- Reformat in **one dedicated PR** and add it to **`.git-blame-ignore-revs`**.
- Run **`dotnet format --verify-no-changes`** in CI before the build. Pin the SDK with `global.json`.
- Once tooling enforces formatting, **stop discussing whitespace in reviews**.
