import type { PlaylistTrack } from "../../shared/types.ts";
import {
	type CompanionStatus,
	type CompanionTrack,
	type LocalMatch,
	MAX_MATCH_TRACKS,
	type MatchedBy,
	type MatchResponse,
	type MatchResult,
	negotiateProtocol,
} from "./companionProtocol.ts";
import { isPurchased, type PurchasedMap } from "./purchasedStore.ts";

export const COMPANION_STORAGE_KEY = "spotify-shopping-cart:companion";
export const COMPANION_MATCHES_STORAGE_KEY = "spotify-shopping-cart:companion-matches";

export type CompanionPairing = {
	token: string;
};

// Results of the last check, valid only for the library revision they were computed against.
export type MatchCache = {
	libraryRevision: string;
	results: Readonly<Record<string, MatchResult>>;
	// Track URI -> id of the best match the user dismissed; kept across revisions.
	dismissed: Readonly<Record<string, string>>;
};

export type CheckResult = {
	libraryRevision: string;
	results: ReadonlyMap<string, MatchResult>;
};

export type CheckClient = {
	status: () => Promise<CompanionStatus>;
	match: (protocol: number, tracks: CompanionTrack[]) => Promise<MatchResponse>;
};

export type LocalMatchView =
	| { kind: "owned"; match: LocalMatch | undefined }
	| { kind: "review"; match: LocalMatch; matchedBy: MatchedBy | null };

export type MatchSummary = {
	checked: number;
	owned: number;
	toReview: number;
};

// A re-index finishing mid-check changes the revision between requests, which restarts the check.
const MAX_CHECK_ATTEMPTS = 3;

export class NoCommonProtocolError extends Error {
	constructor(readonly offered: unknown) {
		super("the companion offers no protocol this app speaks");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePairing(raw: string | null): CompanionPairing | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return isRecord(value) && typeof value.token === "string" && value.token !== "" ? { token: value.token } : null;
	} catch {
		return null;
	}
}

export function parseMatchCache(raw: string | null): MatchCache | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || typeof value.libraryRevision !== "string" || !isRecord(value.results)) return null;
		const dismissed = isRecord(value.dismissed)
			? Object.fromEntries(Object.entries(value.dismissed).filter(([, id]) => typeof id === "string"))
			: {};
		return {
			libraryRevision: value.libraryRevision,
			results: value.results as Record<string, MatchResult>,
			dismissed: dismissed as Record<string, string>,
		};
	} catch {
		return null;
	}
}

// Local files are left out because they can't be purchased; each URI is sent once.
export function toCompanionTracks(items: PlaylistTrack[]): CompanionTrack[] {
	const tracks = new Map<string, CompanionTrack>();
	for (const track of items) {
		if (track.isLocal || tracks.has(track.uri)) continue;
		tracks.set(track.uri, {
			key: track.uri,
			title: track.name,
			artists: track.artists,
			album: {
				id: track.album.id,
				title: track.album.name,
				artists: track.album.artists,
				totalTracks: track.album.totalTracks,
			},
			durationMs: track.durationMs,
			isrc: track.isrc,
			trackNumber: track.trackNumber,
			discNumber: track.discNumber,
		});
	}
	return [...tracks.values()];
}

// Returns null when the library revision changed between requests.
async function matchAll(
	client: CheckClient,
	protocol: number,
	libraryRevision: string,
	tracks: CompanionTrack[],
): Promise<MatchResult[] | null> {
	const results: MatchResult[] = [];
	for (let i = 0; i < tracks.length; i += MAX_MATCH_TRACKS) {
		const chunk = tracks.slice(i, i + MAX_MATCH_TRACKS);
		const response = await client.match(protocol, chunk);
		if (response.libraryRevision !== libraryRevision) return null;
		const keys = new Set(chunk.map((track) => track.key));
		results.push(...response.results.filter((result) => keys.has(result.key) && Array.isArray(result.matches)));
	}
	return results;
}

// Asks the companion only about tracks the cache has no result for at the current library revision.
export async function checkLibrary(
	tracks: CompanionTrack[],
	cache: MatchCache | null,
	client: CheckClient,
): Promise<CheckResult> {
	for (let attempt = 0; attempt < MAX_CHECK_ATTEMPTS; attempt++) {
		const status = await client.status();
		const protocol = negotiateProtocol(status.protocols);
		if (protocol === null) throw new NoCommonProtocolError(status.protocols);

		const results = new Map<string, MatchResult>();
		if (cache?.libraryRevision === status.libraryRevision) {
			for (const track of tracks) {
				const result = cache.results[track.key];
				if (result) results.set(track.key, result);
			}
		}
		const pending = tracks.filter((track) => !results.has(track.key));
		const fresh = await matchAll(client, protocol, status.libraryRevision, pending);
		if (fresh === null) continue;
		for (const result of fresh) results.set(result.key, result);
		return { libraryRevision: status.libraryRevision, results };
	}
	throw new Error("the companion's library kept changing during the check");
}

// Dismissals of tracks no longer checked are dropped along with their results.
export function updateMatchCache(previous: MatchCache | null, check: CheckResult): MatchCache {
	return {
		libraryRevision: check.libraryRevision,
		results: Object.fromEntries(check.results),
		dismissed: Object.fromEntries(
			Object.entries(previous?.dismissed ?? {}).filter(([uri]) => check.results.has(uri)),
		),
	};
}

export function dismissMatch(cache: MatchCache, uri: string, matchId: string): MatchCache {
	return { ...cache, dismissed: { ...cache.dismissed, [uri]: matchId } };
}

function isDismissed(cache: MatchCache, uri: string, match: LocalMatch | undefined): boolean {
	return match !== undefined && cache.dismissed[uri] === match.id;
}

// Owned tracks that aren't marked yet, leaving out matches the user dismissed.
export function unmarkedOwnedUris(cache: MatchCache, items: PlaylistTrack[], purchased: PurchasedMap): string[] {
	const uris = items
		.filter((track) => {
			const result = cache.results[track.uri];
			return (
				!track.isLocal &&
				result?.verdict === "owned" &&
				!isDismissed(cache, track.uri, result.matches[0]) &&
				!isPurchased(purchased, track)
			);
		})
		.map((track) => track.uri);
	return [...new Set(uris)];
}

export function localMatchView(
	cache: MatchCache,
	track: PlaylistTrack,
	isTrackPurchased: boolean,
): LocalMatchView | null {
	if (track.isLocal) return null;
	const result = cache.results[track.uri];
	if (!result) return null;
	const [match] = result.matches;
	if (isDismissed(cache, track.uri, match)) return null;
	if (result.verdict === "owned") return { kind: "owned", match };
	if (result.verdict === "probable" && match && !isTrackPurchased) {
		return { kind: "review", match, matchedBy: result.matchedBy };
	}
	return null;
}

export function summarizeMatches(cache: MatchCache, items: PlaylistTrack[], purchased: PurchasedMap): MatchSummary {
	const checked = new Set<string>();
	const owned = new Set<string>();
	const toReview = new Set<string>();
	for (const track of items) {
		if (track.isLocal || !cache.results[track.uri]) continue;
		checked.add(track.uri);
		const view = localMatchView(cache, track, isPurchased(purchased, track));
		if (view?.kind === "owned") owned.add(track.uri);
		if (view?.kind === "review") toReview.add(track.uri);
	}
	return { checked: checked.size, owned: owned.size, toReview: toReview.size };
}

export function moraPackageUrl(match: LocalMatch): string | null {
	const mora = match.ids.mora;
	if (!mora) return null;
	const url = new URL(
		`https://mora.jp/package/${encodeURIComponent(mora.labelCode)}/${encodeURIComponent(mora.packageId)}/`,
	);
	url.searchParams.set("trackMaterialNo", mora.materialNo);
	return url.toString();
}
