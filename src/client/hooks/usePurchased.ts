import {
	markPurchased,
	PURCHASED_STORAGE_KEY,
	type PurchasedMap,
	parsePurchased,
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

export function unmarkTracksPurchased(uris: string[]) {
	store.set(unmarkPurchased(store.get(), uris));
}

// Shared across tabs through the storage event.
export function usePurchased(): PurchasedMap {
	return store.use();
}
