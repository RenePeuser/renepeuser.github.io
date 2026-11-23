// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import mermaid from 'astro-mermaid';
import { readFileSync } from 'node:fs';

// The "Blog series" sidebar is built from the series pages: every <LinkCard href="/blog/..."> becomes
// an entry, in the order the series page lists it. A new post only needs a LinkCard on its series page.
// Keep every series page linked here published (no `draft: true`), or the production build fails.
const blogSeries = [
	['aspnetcore-from-the-ground-up', '1 · ASP.NET Core from the ground up'],
	['architecture-in-practice', '2 · Architecture in practice'],
	['dotnet-pitfalls', '3 · .NET pitfalls'],
	['validation-and-error-handling', '4 · Validation & error handling'],
	['rest-and-openapi-design', '5 · REST & OpenAPI design'],
	['testing-in-practice', '6 · Testing in practice'],
	['code-quality-and-tooling', '7 · Code quality & tooling'],
	['caching-and-data', '8 · Caching & data'],
	['cloud-devops-observability', '9 · Cloud, DevOps & observability'],
	['scrum-in-the-real-world', '10 · Scrum in the real world'],
];
const linkCard = /<LinkCard\s+title=(["'])(.*?)\1\s+href="(\/blog\/[^"]+)"/g;
/** @param {string} slug */
const seriesPosts = (slug) => {
	const source = readFileSync(new URL(`./src/content/docs/series/${slug}.mdx`, import.meta.url), 'utf8');
	return [...source.matchAll(linkCard)].map((m) => ({ label: m[2], link: m[3] }));
};
const seriesSidebar = {
	label: 'Blog series',
	items: [
		{ label: 'All series', slug: 'series' },
		...blogSeries.map(([slug, label]) => ({
			label,
			collapsed: true,
			items: [{ label: 'Series overview', slug: `series/${slug}` }, ...seriesPosts(slug)],
		})),
		{ label: 'From VB6 to self-defending codebases', slug: 'series/from-vb6-to-self-defending-codebases' },
	],
};

// https://astro.build/config
export default defineConfig({
	// User site: served from the root of https://renepeuser.github.io (no `base` needed).
	site: 'https://renepeuser.github.io',
	integrations: [
		// Must come before Starlight so ```mermaid blocks are rendered as diagrams.
		mermaid({ autoTheme: true }),
		starlight({
			title: 'Rene Peuser',
			description:
				'Principal Software Architect, framework engineer, SDK author and speaker. Writing about .NET, API platforms, testing and developer experience.',
			logo: { src: './src/assets/logo.svg', alt: 'RP' },
			favicon: '/favicon.svg',
			customCss: ['./src/styles/custom.css'],
			components: {
				Pagination: './src/components/Pagination.astro',
			},
			plugins: [
				starlightBlog({
					title: 'Blog',
					metrics: { readingTime: true },
					authors: {
						rene: {
							name: 'Rene Peuser',
							title: 'Principal Software Architect',
							picture: 'https://github.com/RenePeuser.png',
							url: 'https://github.com/RenePeuser',
						},
					},
				}),
			],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/RenePeuser' },
				{ icon: 'rss', label: 'RSS', href: 'https://renepeuser.github.io/blog/rss.xml' },
			],
			sidebar: [
				seriesSidebar,
				{
					label: 'About',
					items: [
						{ label: 'Executive profile', slug: 'about/profile' },
						{ label: 'Engineering philosophy', slug: 'about/engineering-philosophy' },
						{ label: 'Principles', slug: 'about/principles' },
						{ label: 'Technical identity', slug: 'about/technical-identity' },
					],
				},
				{
					label: 'Career',
					collapsed: true,
					items: [
						{ label: 'Engineering journey', slug: 'career/timeline' },
						{ label: 'Siemens', slug: 'career/siemens' },
						{ label: 'SoftwareOne', slug: 'career/softwareone' },
						{ label: 'TRUMPF', slug: 'career/trumpf' },
						{ label: 'Earlier career', slug: 'career/earlier-career' },
						{ label: 'Legacy project archive', slug: 'career/legacy-projects' },
					],
				},
				{
					label: 'Projects',
					collapsed: true,
					items: [
						{ label: 'Portfolio overview', slug: 'projects' },
						{ label: 'Capability meta-framework', slug: 'projects/capability-meta-framework' },
						{ label: 'Minimal API platform', slug: 'projects/minimal-api-platform' },
						{ label: 'Testing SDK', slug: 'projects/testing-sdk' },
						{ label: 'Validation engine', slug: 'projects/validation-engine' },
						{ label: 'OpenAPI infrastructure', slug: 'projects/openapi-infrastructure' },
						{ label: 'Error handling', slug: 'projects/error-handling' },
						{ label: 'Deployment & provider model', slug: 'projects/deployment-provider-model' },
						{ label: 'Developer experience', slug: 'projects/developer-experience' },
					],
				},
				{
					label: 'Architecture',
					collapsed: true,
					items: [
						{ label: 'Framework engineering', slug: 'architecture/framework-engineering' },
						{ label: 'Testing is architecture', slug: 'architecture/testing-is-architecture' },
						{ label: 'API design', slug: 'architecture/api-design' },
						{ label: 'Performance', slug: 'architecture/performance' },
						{ label: 'ADR index', slug: 'architecture/adrs' },
						{ label: 'ADR 001 · Conditional validation', slug: 'architecture/adrs/001-conditional-validation' },
						{ label: 'ADR 002 · Infra/backend validators', slug: 'architecture/adrs/002-validator-sync-strategy' },
					],
				},
				{
					label: 'Open Source',
					collapsed: true,
					items: [
						{ label: 'Overview', slug: 'open-source' },
						{ label: 'NuGet portfolio', slug: 'open-source/nuget' },
						{ label: 'GitHub & Azure DevOps', slug: 'open-source/repositories' },
					],
				},
				{
					label: 'Expertise',
					collapsed: true,
					items: [
						{ label: 'Technology map', slug: 'expertise/technology-map' },
						{ label: '.NET & C#', slug: 'expertise/dotnet' },
						{ label: 'Cloud', slug: 'expertise/cloud' },
						{ label: 'Testing', slug: 'expertise/testing' },
						{ label: 'Roslyn & tooling', slug: 'expertise/roslyn-tooling' },
					],
				},
				{
					label: 'Speaking',
					collapsed: true,
					items: [
						{ label: 'BASTA!', slug: 'talks/basta' },
						{ label: 'My Coding Zone', slug: 'talks/my-coding-zone' },
						{ label: 'Speaker kit', slug: 'talks/speaker-kit' },
					],
				},
				{
					label: 'Resume',
					collapsed: true,
					items: [
						{ label: 'Short resume', slug: 'resume/resume-short' },
						{ label: 'Full resume', slug: 'resume/resume-full' },
						{ label: 'Project profile', slug: 'resume/project-profile' },
					],
				},
				{
					label: 'Elsewhere',
					collapsed: true,
					items: [
						{ label: 'NuGet profile', link: 'https://www.nuget.org/profiles/Rene.Peuser', attrs: { target: '_blank' } },
						{ label: 'BASTA! speaker profile', link: 'https://basta.net/speaker/rene-peuser/', attrs: { target: '_blank' } },
						{ label: 'Source & confidentiality policy', slug: 'portfolio/source-policy' },
					],
				},
			],
		}),
	],
});
