import type { PlaylistTrack } from "../../shared/types.ts";

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

// A track re-added to the playlist after it was marked counts as not purchased again.
export function isPurchased(map: PurchasedMap, track: PlaylistTrack): boolean {
	const at = map[track.uri];
	if (at === undefined) return false;
	return track.addedAt === null || Date.parse(at) >= Date.parse(track.addedAt);
}
