import { describe, expect, test } from "bun:test";
import type { Cache, State } from "swr";
import { ApiRequestError } from "../../src/client/api.ts";
import { buildDebugExport, debugExportFilename } from "../../src/client/lib/debugExport.ts";

function storage(entries: Record<string, string>): Pick<Storage, "length" | "key" | "getItem"> {
	const keys = Object.keys(entries);
	return {
		length: keys.length,
		key: (index) => keys[index] ?? null,
		getItem: (key) => entries[key] ?? null,
	};
}

function cache(entries: Record<string, State>): Pick<Cache, "keys" | "get"> {
	const map = new Map(Object.entries(entries));
	return { keys: () => map.keys(), get: (key) => map.get(key) };
}

describe("debugExport", () => {
	test("exports localStorage values, parsing JSON where possible", () => {
		const result = buildDebugExport({
			now: new Date("2026-10-05T01:02:03.456Z"),
			url: "https://app.test/playlists/p1",
			userAgent: "test-agent",
			storage: storage({
				"spotify-shopping-cart:purchased": '{"spotify:track:1":"2026-10-01T00:00:00.000Z"}',
				plain: "not json",
			}),
			cache: cache({}),
		});
		expect(result).toEqual({
			exportedAt: "2026-10-05T01:02:03.456Z",
			url: "https://app.test/playlists/p1",
			userAgent: "test-agent",
			localStorage: {
				"spotify-shopping-cart:purchased": { "spotify:track:1": "2026-10-01T00:00:00.000Z" },
				plain: "not json",
			},
			swrCache: {},
		});
	});

	test("exports SWR data and errors without loading flags", () => {
		const result = buildDebugExport({
			now: new Date("2026-10-05T00:00:00Z"),
			url: "https://app.test/",
			userAgent: "test-agent",
			storage: storage({}),
			cache: cache({
				"/api/me": { data: { id: "u1", displayName: null }, isValidating: false, isLoading: false },
				"/api/playlists/p1": {
					error: new ApiRequestError(429, "rate_limited", 30),
					isValidating: true,
				},
			}),
		});
		expect(JSON.parse(JSON.stringify(result.swrCache))).toEqual({
			"/api/me": { data: { id: "u1", displayName: null } },
			"/api/playlists/p1": {
				error: {
					name: "Error",
					message: "request failed with 429 (rate_limited)",
					status: 429,
					code: "rate_limited",
					retryAfter: 30,
				},
			},
		});
	});

	test("builds a filename safe for every OS", () => {
		expect(debugExportFilename("2026-10-05T01:02:03.456Z")).toBe(
			"spotify-shopping-cart-debug-2026-10-05T01-02-03-456Z.json",
		);
	});
});
