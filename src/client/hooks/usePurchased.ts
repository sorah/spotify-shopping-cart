import { useSyncExternalStore } from "react";
import {
	markPurchased,
	PURCHASED_STORAGE_KEY,
	type PurchasedMap,
	parsePurchased,
	unmarkPurchased,
} from "../lib/purchasedStore.ts";

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedMap: PurchasedMap = {};

function getSnapshot(): PurchasedMap {
	const raw = localStorage.getItem(PURCHASED_STORAGE_KEY);
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cachedMap = parsePurchased(raw);
	}
	return cachedMap;
}

function onStorage(event: StorageEvent) {
	if (event.key === PURCHASED_STORAGE_KEY || event.key === null) for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("storage", onStorage);
	};
}

function write(map: PurchasedMap) {
	localStorage.setItem(PURCHASED_STORAGE_KEY, JSON.stringify(map));
	for (const listener of listeners) listener();
}

export function markTracksPurchased(uris: string[]) {
	write(markPurchased(getSnapshot(), uris, new Date()));
}

export function unmarkTracksPurchased(uris: string[]) {
	write(unmarkPurchased(getSnapshot(), uris));
}

// Shared across tabs through the storage event.
export function usePurchased(): PurchasedMap {
	return useSyncExternalStore(subscribe, getSnapshot);
}
