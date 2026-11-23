// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';

// https://astro.build/config
export default defineConfig({
	// User site: served from the root of https://renepeuser.github.io (no `base` needed).
	site: 'https://renepeuser.github.io',
	integrations: [
		starlight({
			title: 'Rene Peuser',
			description:
				'Principal Software Architect, framework engineer, SDK author and speaker. Writing about .NET, API platforms, testing and developer experience.',
			customCss: ['./src/styles/custom.css'],
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
				{
					label: 'About',
					items: [
						{ label: 'Profile', slug: 'about/profile' },
						{ label: 'Engineering philosophy', slug: 'about/engineering-philosophy' },
					],
				},
				{
					label: 'Projects',
					items: [{ autogenerate: { directory: 'projects' } }],
				},
				{
					label: 'Speaking',
					items: [{ autogenerate: { directory: 'talks' } }],
				},
				{
					label: 'Elsewhere',
					items: [
						{ label: 'NuGet profile', link: 'https://www.nuget.org/profiles/Rene.Peuser', attrs: { target: '_blank' } },
						{ label: 'BASTA! speaker profile', link: 'https://basta.net/speaker/rene-peuser/', attrs: { target: '_blank' } },
					],
				},
			],
		}),
	],
});
