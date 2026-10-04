import {
	markPurchased,
	PURCHASED_STORAGE_KEY,
	type PurchasedMap,
	parsePurchased,
	pickPurchased,
	restorePurchased,
	unmarkPurchased,
} from "../lib/purchasedStore.ts";
import { createLocalStore } from "./localStore.ts";

const store = createLocalStore(PURCHASED_STORAGE_KEY, parsePurchased);

export function getPurchased(): PurchasedMap {
	return store.get();
}

export function markTracksPurchased(uris: string[]) {
	store.set(markPurchased(store.get(), uris, new Date()));
}

// Returns the removed marks for restoreTracksPurchased.
export function unmarkTracksPurchased(uris: string[]): PurchasedMap {
	const current = store.get();
	store.set(unmarkPurchased(current, uris));
	return pickPurchased(current, uris);
}

// Keeps the original mark times, so the purchased panel order and the re-added check stay as they were.
export function restoreTracksPurchased(marks: PurchasedMap) {
	store.set(restorePurchased(store.get(), marks));
}

// Shared across tabs through the storage event.
export function usePurchased(): PurchasedMap {
	return store.use();
}
