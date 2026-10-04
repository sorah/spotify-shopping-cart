import type { PlaylistTrack } from "../../shared/types.ts";
import type { AlbumGroup } from "./grouping.ts";

export const PURCHASED_STORAGE_KEY = "spotify-shopping-cart:purchased";

// Track URI -> ISO time it was marked purchased.
export type PurchasedMap = Readonly<Record<string, string>>;

export function parsePurchased(raw: string | null): PurchasedMap {
	if (!raw) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === "string"));
	} catch {
		return {};
	}
}

export function markPurchased(map: PurchasedMap, uris: string[], now: Date): PurchasedMap {
	const at = now.toISOString();
	return { ...map, ...Object.fromEntries(uris.map((uri) => [uri, at])) };
}

export function unmarkPurchased(map: PurchasedMap, uris: string[]): PurchasedMap {
	const removed = new Set(uris);
	return Object.fromEntries(Object.entries(map).filter(([uri]) => !removed.has(uri)));
}

export function pickPurchased(map: PurchasedMap, uris: string[]): PurchasedMap {
	return Object.fromEntries(uris.flatMap((uri) => (map[uri] === undefined ? [] : [[uri, map[uri]]])));
}

// Marks made after the snapshot was taken win over the restored ones.
export function restorePurchased(map: PurchasedMap, snapshot: PurchasedMap): PurchasedMap {
	return { ...snapshot, ...map };
}

// A track re-added to the playlist after it was marked counts as not purchased again.
export function isPurchased(map: PurchasedMap, track: PlaylistTrack): boolean {
	const at = map[track.uri];
	if (at === undefined) return false;
	return track.addedAt === null || Date.parse(at) >= Date.parse(track.addedAt);
}

// Each group keeps its purchased tracks once per URI; the most recently marked group comes first.
export function purchasedGroups(groups: AlbumGroup[], map: PurchasedMap): AlbumGroup[] {
	const marked: { group: AlbumGroup; latestMarkedAt: number }[] = [];
	for (const group of groups) {
		const tracks = new Map<string, PlaylistTrack>();
		let latestMarkedAt = 0;
		for (const track of group.tracks) {
			const at = map[track.uri];
			if (track.isLocal || at === undefined || tracks.has(track.uri) || !isPurchased(map, track)) continue;
			tracks.set(track.uri, track);
			latestMarkedAt = Math.max(latestMarkedAt, Date.parse(at));
		}
		if (tracks.size > 0) marked.push({ group: { ...group, tracks: [...tracks.values()] }, latestMarkedAt });
	}
	return marked.toSorted((a, b) => b.latestMarkedAt - a.latestMarkedAt).map(({ group }) => group);
}
