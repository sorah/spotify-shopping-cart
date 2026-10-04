import type { PlaylistTrack } from "../../shared/types.ts";

export type AlbumGroup = {
	key: string;
	album: PlaylistTrack["album"];
	tracks: PlaylistTrack[];
	latestAddedAt: string | null;
};

// Newest first; tracks added together keep their playlist order; unknown dates go last.
function compareTracks(a: PlaylistTrack, b: PlaylistTrack): number {
	return compareAddedAt(a.addedAt, b.addedAt) || a.position - b.position;
}

function compareAddedAt(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return Date.parse(b) - Date.parse(a);
}

export function albumKey(track: PlaylistTrack): string {
	return track.album.id ?? `local:${track.album.name}`;
}

export function groupByAlbum(items: PlaylistTrack[]): AlbumGroup[] {
	const groups = new Map<string, AlbumGroup>();
	for (const track of items.toSorted(compareTracks)) {
		const key = albumKey(track);
		const group = groups.get(key);
		if (group) {
			group.tracks.push(track);
		} else {
			groups.set(key, { key, album: track.album, tracks: [track], latestAddedAt: track.addedAt });
		}
	}
	return [...groups.values()];
}
