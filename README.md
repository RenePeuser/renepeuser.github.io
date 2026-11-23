# renepeuser.github.io

Personal website and developer blog of Rene Peuser — built with [Astro](https://astro.build),
[Starlight](https://starlight.astro.build) and [starlight-blog](https://github.com/HiDeoo/starlight-blog),
hosted on GitHub Pages.

**Live:** https://renepeuser.github.io

## Write a new blog post

Create a Markdown file in `src/content/docs/blog/`:

```markdown
---
title: My new post
date: 2026-11-23
authors: rene
tags: [dotnet, testing]
excerpt: One or two sentences shown in the post list.
---

Content goes here…
```

Push to `main` — GitHub Actions builds and deploys automatically.

## Local development

| Command           | Action                                   |
| :---------------- | :--------------------------------------- |
| `npm install`     | Install dependencies                     |
| `npm run dev`     | Start dev server at `localhost:4321`     |
| `npm run build`   | Build the production site to `./dist/`   |
| `npm run preview` | Preview the production build locally     |

## Structure

```
src/content/docs/
├── index.mdx        → home page
├── about/           → profile & philosophy
├── projects/        → project case studies
├── talks/           → speaking
└── blog/            → blog posts
```
