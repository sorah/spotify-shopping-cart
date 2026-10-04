import type { Cache } from "swr";
import { COMPANION_STORAGE_KEY } from "./companionMatch.ts";

export type DebugExport = {
	exportedAt: string;
	url: string;
	userAgent: string;
	localStorage: Record<string, unknown>;
	// Keyed by SWR's serialized cache key; array keys look like `@"playlist-items","<id>",`.
	swrCache: Record<string, { data?: unknown; error?: unknown }>;
};

type Environment = {
	now: Date;
	url: string;
	userAgent: string;
	storage: Pick<Storage, "length" | "key" | "getItem">;
	cache: Pick<Cache, "keys" | "get">;
};

// Debug exports get shared, so values that grant access to something are left out.
const REDACTED_STORAGE_KEYS = new Set([COMPANION_STORAGE_KEY]);

function parseStoredValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

// Error's name and message are not own enumerable properties, so JSON.stringify would drop them.
function serializeError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	return { ...error, name: error.name, message: error.message };
}

export function buildDebugExport({ now, url, userAgent, storage, cache }: Environment): DebugExport {
	const localStorage: Record<string, unknown> = {};
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		const raw = key === null ? null : storage.getItem(key);
		if (key === null || raw === null) continue;
		localStorage[key] = REDACTED_STORAGE_KEYS.has(key) ? "[redacted]" : parseStoredValue(raw);
	}

	const swrCache: DebugExport["swrCache"] = {};
	for (const key of cache.keys()) {
		const state = cache.get(key);
		if (state) swrCache[key] = { data: state.data, error: serializeError(state.error) };
	}

	return { exportedAt: now.toISOString(), url, userAgent, localStorage, swrCache };
}

export function debugExportFilename(exportedAt: string): string {
	return `spotify-shopping-cart-debug-${exportedAt.replace(/[:.]/g, "-")}.json`;
}
