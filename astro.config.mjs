// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import mermaid from 'astro-mermaid';
import { series, seriesGroups } from './src/data/series.mjs';

// Draft pages only exist in `astro dev`; linking them in a production build would fail.
const isDev = process.argv.includes('dev');

// "Series" topic: the series, grouped by theme. The series pages list their posts as chapters, and every
// post shows its own series navigation, so the sidebar only needs the series themselves.
// Series and groups come from src/data/series.mjs. Keep every series page published (no `draft: true`).
const seriesSidebar = [
	{ label: 'All series', slug: 'series' },
	...seriesGroups.map((group) => ({
		label: group.title,
		items: series
			.filter((s) => s.group === group.id)
			.map((s) => ({ label: s.title, slug: `series/${s.slug}` })),
	})),
];

const architectureSidebar = {
	label: 'Architecture',
	collapsed: true,
	badge: { text: 'draft', variant: 'caution' },
	items: [
		{ label: 'Framework engineering', slug: 'architecture/framework-engineering' },
		{ label: 'Testing is architecture', slug: 'architecture/testing-is-architecture' },
		{ label: 'API design', slug: 'architecture/api-design' },
		{ label: 'Performance', slug: 'architecture/performance' },
		{ label: 'ADR index', slug: 'architecture/adrs' },
		{ label: 'ADR 001 · Conditional validation', slug: 'architecture/adrs/001-conditional-validation' },
		{ label: 'ADR 002 · Infra/backend validators', slug: 'architecture/adrs/002-validator-sync-strategy' },
	],
};

// "Profile" topic: everything about me — background, work, talks and resume.
const profileSidebar = [
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
	// The architecture pages are drafts (`draft: true`): visible in `astro dev` only.
	...(isDev ? [architectureSidebar] : []),
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
];

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
				PageTitle: './src/components/PageTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
			},
			plugins: [
				starlightBlog({
					title: 'Blog',
					// The header navigation (Blog · Series · Profile) comes from src/components/SocialIcons.astro.
					navigation: 'none',
					metrics: { readingTime: true },
					postCount: 12,
					authors: {
						rene: {
							name: 'Rene Peuser',
							title: 'Principal Software Architect',
							picture: 'https://github.com/RenePeuser.png',
							url: 'https://github.com/RenePeuser',
						},
					},
				}),
				// Three areas with their own sidebar, linked from the header: blog, series and profile.
				// The blog sidebar itself (all posts, recent posts, tags) is generated by starlight-blog.
				starlightSidebarTopics(
					[
						{ id: 'blog', label: 'Blog', link: '/blog/', icon: 'document', items: [{ label: 'All posts', link: '/blog/' }] },
						{ id: 'series', label: 'Series', link: '/series/', icon: 'open-book', items: seriesSidebar },
						{ id: 'profile', label: 'Profile', link: '/about/profile/', icon: 'information', items: profileSidebar },
					],
					{ topics: { blog: ['/blog', '/blog/**/*'] } },
				),
			],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/RenePeuser' },
				{ icon: 'rss', label: 'RSS', href: 'https://renepeuser.github.io/blog/rss.xml' },
			],
		}),
	],
});
