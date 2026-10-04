const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export function formatDate(iso: string | null): string {
	return iso ? DATE_FORMAT.format(new Date(iso)) : "";
}

export function joinArtists(artists: string[]): string {
	return artists.join(", ");
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

const NUMBER_FORMAT = new Intl.NumberFormat();

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${NUMBER_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

// Sign dropped, tenths below 10s: "0.2s", "14s", "1:05".
export function formatDurationDifference(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < 10_000) return `${(abs / 1000).toFixed(1)}s`;
	const seconds = Math.round(abs / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
