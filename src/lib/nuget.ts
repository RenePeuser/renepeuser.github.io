// Fetches NuGet download statistics for the profile owner at build time.
// The same query runs again in the browser (see NuGetLive.astro) so figures stay live.

export const NUGET_OWNER = 'Rene.Peuser';

// prerelease + semVerLevel are required, otherwise packages with only SemVer2/prerelease versions are missing.
export const NUGET_QUERY_URL = `https://azuresearch-usnc.nuget.org/query?q=owner:${NUGET_OWNER}&prerelease=true&semVerLevel=2.0.0&take=100`;

export interface NuGetPackage {
	id: string;
	downloads: number;
	description: string;
}

export interface NuGetStats {
	packages: NuGetPackage[];
	total: number;
	fetchedAt: Date | null;
}

let cache: Promise<NuGetStats> | undefined;

export function getNuGetStats(): Promise<NuGetStats> {
	cache ??= load();
	return cache;
}

async function load(): Promise<NuGetStats> {
	try {
		const res = await fetch(NUGET_QUERY_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as {
			data: { id: string; totalDownloads: number; description: string; owners: string[] }[];
		};
		const packages = json.data
			.filter((p) => p.owners.some((o) => o.toLowerCase() === NUGET_OWNER.toLowerCase()))
			.map((p) => ({ id: p.id, downloads: p.totalDownloads, description: p.description }))
			.sort((a, b) => b.downloads - a.downloads);
		return { packages, total: packages.reduce((s, p) => s + p.downloads, 0), fetchedAt: new Date() };
	} catch (err) {
		// Never fail the build because NuGet is unreachable; components fall back to static text.
		console.warn(`[nuget] Could not fetch download statistics: ${err}`);
		return { packages: [], total: 0, fetchedAt: null };
	}
}

/** "more than 4.5 million" — rounded down so the claim is always true. */
export function formatMillions(total: number): string {
	return `${(Math.floor(total / 100_000) / 10).toFixed(1)} million`;
}

export function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return String(n);
}
