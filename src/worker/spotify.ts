import type { Context } from "hono";
import type { GetMeResponse, GetPlaylistItemsResponse, GetPlaylistResponse, PlaylistTrack } from "../shared/types.ts";
import type { AppEnv } from "./env.ts";
import { parseLastShopping } from "./lastShopping.ts";
import { refreshSession } from "./session.ts";

const API_BASE = "https://api.spotify.com/v1";
export const ITEMS_PAGE_SIZE = 50;
export const REMOVE_CHUNK_SIZE = 100;

type SpotifyImage = {
	url: string;
	width: number | null;
};

type SpotifyArtist = {
	name: string;
};

type SpotifyTrack = {
	type: "track";
	uri: string;
	name: string;
	is_local?: boolean;
	artists?: SpotifyArtist[];
	album?: {
		id: string | null;
		name: string;
		total_tracks?: number | null;
		images?: SpotifyImage[] | null;
		artists?: SpotifyArtist[];
	};
};

type SpotifyEpisode = {
	type: "episode";
};

export type SpotifyPlaylistItem = {
	added_at: string | null;
	is_local?: boolean;
	item?: SpotifyTrack | SpotifyEpisode | null;
	track?: SpotifyTrack | SpotifyEpisode | null;
};

export type SpotifyItemsPage = {
	next: string | null;
	total: number;
	items: SpotifyPlaylistItem[];
};

type SpotifyPlaylist = {
	id: string;
	name: string;
	description: string | null;
	owner: { id: string; display_name: string | null };
	collaborative: boolean;
	images: SpotifyImage[] | null;
	external_urls: { spotify: string };
};

type SpotifyUser = {
	id: string;
	display_name: string | null;
};

const TRACK_FIELDS = "type,uri,name,is_local,artists(name),album(id,name,total_tracks,images,artists(name))";
// Spotify is migrating from "track" to "item"; request both so the filter keeps whichever is present.
const ITEMS_FIELDS = `next,total,items(added_at,is_local,item(${TRACK_FIELDS}),track(${TRACK_FIELDS}))`;
const PLAYLIST_FIELDS = "id,name,description,owner(id,display_name),collaborative,images,external_urls";

export class SpotifyApiError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfter: string | undefined,
	) {
		super(`Spotify API returned ${status}`);
	}
}

// Retries once with a refreshed token when Spotify rejects the current one.
async function spotifyFetch(c: Context<AppEnv>, path: string, init: RequestInit = {}): Promise<Response> {
	const send = (accessToken: string) =>
		fetch(`${API_BASE}${path}`, {
			...init,
			headers: {
				...init.headers,
				Authorization: `Bearer ${accessToken}`,
				// Localized names match mora's Japanese catalog better than romanized ones.
				"Accept-Language": "ja",
			},
		});

	let response = await send(c.var.session.accessToken);
	if (response.status === 401) {
		const session = await refreshSession(c);
		response = await send(session.accessToken);
	}
	if (!response.ok) throw new SpotifyApiError(response.status, response.headers.get("Retry-After") ?? undefined);
	return response;
}

async function spotifyJson<T>(c: Context<AppEnv>, path: string, init?: RequestInit): Promise<T> {
	return (await (await spotifyFetch(c, path, init)).json()) as T;
}

export async function getMe(c: Context<AppEnv>): Promise<GetMeResponse> {
	const user = await spotifyJson<SpotifyUser>(c, "/me");
	return { id: user.id, displayName: user.display_name };
}

export async function getPlaylist(c: Context<AppEnv>, id: string): Promise<GetPlaylistResponse> {
	const playlist = await spotifyJson<SpotifyPlaylist>(
		c,
		`/playlists/${id}?${new URLSearchParams({ fields: PLAYLIST_FIELDS })}`,
	);
	return {
		id: playlist.id,
		name: playlist.name,
		ownerId: playlist.owner.id,
		ownerName: playlist.owner.display_name,
		collaborative: playlist.collaborative,
		imageUrl: pickImage(playlist.images),
		externalUrl: playlist.external_urls.spotify,
		lastShopping: parseLastShopping(playlist.description),
	};
}

export async function getPlaylistDescription(c: Context<AppEnv>, id: string): Promise<string | null> {
	const playlist = await spotifyJson<Pick<SpotifyPlaylist, "description">>(
		c,
		`/playlists/${id}?${new URLSearchParams({ fields: "description" })}`,
	);
	return playlist.description;
}

// Spotify allows only the playlist owner to change its details, even on collaborative playlists.
export async function updatePlaylistDescription(c: Context<AppEnv>, id: string, description: string): Promise<void> {
	await spotifyFetch(c, `/playlists/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ description }),
	});
}

// "market" is left out on purpose: relinked track URIs cannot be removed from the playlist.
export async function getPlaylistItems(
	c: Context<AppEnv>,
	id: string,
	offset: number,
): Promise<GetPlaylistItemsResponse> {
	const params = new URLSearchParams({
		limit: String(ITEMS_PAGE_SIZE),
		offset: String(offset),
		fields: ITEMS_FIELDS,
	});
	const page = await spotifyJson<SpotifyItemsPage>(c, `/playlists/${id}/items?${params}`);
	return normalizeItemsPage(page, offset);
}

// Removing by URI drops every occurrence of the track in the playlist.
export async function removePlaylistItems(
	c: Context<AppEnv>,
	id: string,
	uris: string[],
): Promise<string | null> {
	let snapshotId: string | null = null;
	for (let i = 0; i < uris.length; i += REMOVE_CHUNK_SIZE) {
		const items = uris.slice(i, i + REMOVE_CHUNK_SIZE).map((uri) => ({ uri }));
		const result = await spotifyJson<{ snapshot_id: string }>(c, `/playlists/${id}/items`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ items }),
		});
		snapshotId = result.snapshot_id;
	}
	return snapshotId;
}

export function normalizeItemsPage(page: SpotifyItemsPage, offset: number): GetPlaylistItemsResponse {
	const items: PlaylistTrack[] = [];
	for (const [index, entry] of page.items.entries()) {
		const track = entry.item ?? entry.track;
		if (!track || track.type !== "track") continue;
		items.push({
			uri: track.uri,
			name: track.name,
			artists: (track.artists ?? []).map((artist) => artist.name),
			album: {
				id: track.album?.id ?? null,
				name: track.album?.name ?? "",
				artists: (track.album?.artists ?? []).map((artist) => artist.name),
				imageUrl: pickImage(track.album?.images),
				totalTracks: track.album?.total_tracks ?? null,
			},
			addedAt: entry.added_at,
			isLocal: entry.is_local ?? track.is_local ?? false,
			position: offset + index,
		});
	}
	return {
		items,
		nextOffset: page.next ? offset + page.items.length : null,
		total: page.total,
	};
}

// Smallest image that still looks sharp as a thumbnail on high-density screens.
function pickImage(images: SpotifyImage[] | null | undefined): string | null {
	if (!images?.length) return null;
	const sorted = images.toSorted((a, b) => (a.width ?? 0) - (b.width ?? 0));
	return (sorted.find((image) => (image.width ?? 0) >= 128) ?? sorted.at(-1)!).url;
}
