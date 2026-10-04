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
