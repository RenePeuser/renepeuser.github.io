import { getCollection } from 'astro:content';
import { series, seriesGroups, type Series } from '../../data/series.mjs';

export interface PostInfo {
	slug: string;
	title: string;
	excerpt?: string;
	minutes: number;
	draft: boolean;
	href: string;
}

const WORDS_PER_MINUTE = 220;

let cache: Map<string, PostInfo> | undefined;

/** All blog posts keyed by slug (file name without extension). Drafts are excluded in production builds. */
export async function getPosts(): Promise<Map<string, PostInfo>> {
	if (cache) return cache;
	const entries = await getCollection('docs', (entry) => entry.id.startsWith('blog/'));
	cache = new Map();
	for (const entry of entries) {
		const draft = Boolean(entry.data.draft);
		if (draft && import.meta.env.PROD) continue;
		const slug = entry.id.slice('blog/'.length);
		const words = (entry.body ?? '').split(/\s+/).filter(Boolean).length;
		cache.set(slug, {
			slug,
			title: entry.data.title,
			excerpt: typeof entry.data.excerpt === 'string' ? entry.data.excerpt : undefined,
			minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
			draft,
			href: `/blog/${slug}/`,
		});
	}
	return cache;
}

/** The posts of a series in reading order, skipping posts that are not (or no longer) published. */
export async function getSeriesPosts(s: Series): Promise<PostInfo[]> {
	const posts = await getPosts();
	return s.posts.map((slug) => posts.get(slug)).filter((p): p is PostInfo => Boolean(p));
}

export const formatMinutes = (minutes: number) =>
	minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim();

export { series, seriesGroups };
