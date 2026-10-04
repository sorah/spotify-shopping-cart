import { useState } from "react";
import useSWR, { mutate } from "swr";
import type { PlaylistTrack } from "../../shared/types.ts";
import { fetchCompanionStatus, postCompanionMatch } from "../companion.ts";
import {
	COMPANION_MATCHES_STORAGE_KEY,
	COMPANION_STORAGE_KEY,
	type CompanionPairing,
	checkLibrary,
	dismissMatch,
	type MatchCache,
	newlyOwnedUris,
	parseMatchCache,
	parsePairing,
	toCompanionTracks,
	updateMatchCache,
} from "../lib/companionMatch.ts";
import { type CompanionStatus, isIndexing } from "../lib/companionProtocol.ts";
import { createLocalStore } from "./localStore.ts";
import { useMe } from "./useMe.ts";
import { getPurchased, markTracksPurchased } from "./usePurchased.ts";

// Carries no token, because the debug export dumps the SWR cache keys.
const STATUS_KEY = "companion:/v1/status";
const INDEXING_POLL_INTERVAL_MS = 2000;

const pairingStore = createLocalStore(COMPANION_STORAGE_KEY, parsePairing);
const matchCacheStore = createLocalStore(COMPANION_MATCHES_STORAGE_KEY, parseMatchCache);

function currentToken(): string {
	const pairing = pairingStore.get();
	if (!pairing) throw new Error("the companion is not paired");
	return pairing.token;
}

export function useCompanionPairing(): CompanionPairing | null {
	return pairingStore.use();
}

export function pairCompanion(token: string) {
	pairingStore.set({ token });
	void mutate(STATUS_KEY);
}

export function unpairCompanion() {
	pairingStore.clear();
	void mutate(STATUS_KEY, undefined, { revalidate: false });
}

export function dismissLocalMatch(uri: string, matchId: string) {
	const cache = matchCacheStore.get();
	if (cache) matchCacheStore.set(dismissMatch(cache, uri, matchId));
}

// Waits for /api/me like every other request, and stays quiet when the companion isn't running.
export function useCompanionStatus() {
	const { data: me } = useMe();
	const pairing = useCompanionPairing();
	return useSWR<CompanionStatus, Error>(
		me && pairing ? STATUS_KEY : null,
		() => fetchCompanionStatus(currentToken()),
		{
			shouldRetryOnError: false,
			// A loopback request costs no Spotify quota, and the library may have been re-indexed meanwhile.
			revalidateOnFocus: true,
			refreshInterval: (status) => (status && isIndexing(status) ? INDEXING_POLL_INTERVAL_MS : 0),
		},
	);
}

export function useCompanionMatches(items: PlaylistTrack[] | undefined) {
	const pairing = useCompanionPairing();
	const status = useCompanionStatus();
	const cache = matchCacheStore.use();
	const [isChecking, setIsChecking] = useState(false);
	const [checkError, setCheckError] = useState<Error>();
	const [markedCount, setMarkedCount] = useState<number>();

	const isStale = cache !== null && status.data !== undefined && status.data.libraryRevision !== cache.libraryRevision;
	// Without a status, the last results are still the best information available.
	const matches: MatchCache | null = pairing && cache && !isStale ? cache : null;

	const check = async () => {
		if (isChecking || !items) return;
		setIsChecking(true);
		setCheckError(undefined);
		setMarkedCount(undefined);
		try {
			const token = currentToken();
			const result = await checkLibrary(toCompanionTracks(items), matchCacheStore.get(), {
				status: () => fetchCompanionStatus(token),
				match: (protocol, tracks) => postCompanionMatch(token, protocol, tracks),
			});
			// Owning one song says nothing about the rest of its album, so only matched tracks are marked.
			const owned = newlyOwnedUris(result.fresh, items, getPurchased());
			if (owned.length > 0) markTracksPurchased(owned);
			matchCacheStore.set(updateMatchCache(matchCacheStore.get(), result));
			setMarkedCount(owned.length);
		} catch (error) {
			console.error(error);
			setCheckError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			setIsChecking(false);
			void status.mutate();
		}
	};

	return { isPaired: pairing !== null, status, matches, isStale, isChecking, checkError, markedCount, check };
}
