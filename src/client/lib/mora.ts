import type { PlaylistTrack } from "../../shared/types.ts";

// Mirrors the redirector's parameter limits.
const MAX_LENGTH = 200;
const MAX_ARTISTS = 10;

export function moraRedirectUrl(track: PlaylistTrack): string {
	const params = new URLSearchParams({
		title: track.name.slice(0, MAX_LENGTH),
		album: track.album.name.slice(0, MAX_LENGTH),
	});
	for (const artist of track.artists.slice(0, MAX_ARTISTS)) params.append("artist", artist.slice(0, MAX_LENGTH));
	for (const artist of track.album.artists.slice(0, MAX_ARTISTS)) {
		params.append("albumArtist", artist.slice(0, MAX_LENGTH));
	}
	if (track.album.totalTracks !== null) params.set("tracks", String(track.album.totalTracks));
	return `/mora/redirect?${params}`;
}
