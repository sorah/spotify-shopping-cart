export type ApiErrorCode =
	| "unauthenticated"
	| "reauth_required"
	| "cross_origin_request"
	| "not_found"
	| "bad_request"
	| "unsupported_media_type"
	| "not_allowlisted"
	| "playlist_forbidden"
	| "rate_limited"
	| "spotify_error";

export type ApiError = {
	code: ApiErrorCode;
	message?: string;
};

export type GetMeResponse = {
	id: string;
	displayName: string | null;
};

export type GetPlaylistResponse = {
	id: string;
	name: string;
	ownerId: string;
	ownerName: string | null;
	collaborative: boolean;
	imageUrl: string | null;
	externalUrl: string;
};

export type PlaylistTrack = {
	uri: string;
	name: string;
	artists: string[];
	album: {
		// null for local files
		id: string | null;
		name: string;
		artists: string[];
		imageUrl: string | null;
		totalTracks: number | null;
	};
	addedAt: string | null;
	isLocal: boolean;
	position: number;
};

export type GetPlaylistItemsResponse = {
	items: PlaylistTrack[];
	nextOffset: number | null;
	total: number;
};

export type RemovePlaylistItemsRequest = {
	uris: string[];
};

export type RemovePlaylistItemsResponse = {
	snapshotId: string | null;
	removed: number;
};
