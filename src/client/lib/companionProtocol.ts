// Wire format of the local library companion (protocol v1, see docs/companion.md).
// Both sides ignore unknown fields, so additive changes don't bump the protocol.

export const SUPPORTED_PROTOCOLS: readonly number[] = [1];
export const MAX_MATCH_TRACKS = 500;

export type CompanionSource = {
	// Configured on the companion, so display `label` instead.
	id: string;
	label: string;
	state: "ready" | "indexing" | "error";
	entries: number;
	indexedAt: string | null;
	progress?: { done: number; total: number };
	error?: string;
};

export type CompanionStatus = {
	protocols: number[];
	version: string;
	libraryRevision: string;
	capabilities: string[];
	sources: CompanionSource[];
};

export type CompanionTrack = {
	// Spotify track URI, echoed back in the result.
	key: string;
	title: string;
	artists: string[];
	album: { id: string | null; title: string; artists: string[]; totalTracks: number | null };
	durationMs: number | null;
	isrc: string | null;
	trackNumber: number | null;
	discNumber: number | null;
};

export type MatchRequest = {
	protocol: number;
	tracks: CompanionTrack[];
};

export type MatchedBy = "isrc" | "store-id" | "metadata";

export type LocalMatch = {
	source: string;
	// Opaque, stable across library revisions.
	id: string;
	title: string;
	artists: string[];
	album: string | null;
	durationMs: number | null;
	// "flat" is a file from a directory source.
	ownership: "purchased" | "matched" | "imported" | "flat" | "apple-music";
	format: string;
	cloudOnly: boolean;
	// A display label, not a usable path.
	location: string;
	metadataSource: "tags" | "itunes-store";
	ids: {
		isrc?: string;
		itunesTrackId?: number;
		itunesCollectionId?: number;
		mora?: { labelCode: string; packageId: string; materialNo: string };
	};
	score: number;
	signals: {
		title: number;
		artist: number;
		album: number | null;
		durationDeltaMs: number | null;
		isrc: boolean | null;
	};
};

export type MatchResult = {
	key: string;
	verdict: "owned" | "probable" | "absent";
	score: number;
	matchedBy: MatchedBy | null;
	// Best first; empty when absent.
	matches: LocalMatch[];
};

export type MatchResponse = {
	protocol: number;
	libraryRevision: string;
	results: MatchResult[];
};

export type CompanionErrorCode =
	| "unpaired"
	| "origin_not_allowed"
	| "protocol_mismatch"
	| "too_many_tracks"
	| "bad_request"
	| "indexing";

export type CompanionErrorBody = {
	protocol?: number;
	code?: CompanionErrorCode;
	message?: string;
};

// The highest protocol both sides speak, or null when there is none.
export function negotiateProtocol(offered: unknown): number | null {
	if (!Array.isArray(offered)) return null;
	const common = SUPPORTED_PROTOCOLS.filter((protocol) => offered.includes(protocol));
	return common.length > 0 ? Math.max(...common) : null;
}

export function isIndexing(status: CompanionStatus): boolean {
	return status.sources.some((source) => source.state === "indexing");
}
