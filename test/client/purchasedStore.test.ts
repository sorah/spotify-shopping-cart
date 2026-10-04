import { describe, expect, test } from "bun:test";
import { isPurchased, markPurchased, parsePurchased, unmarkPurchased } from "../../src/client/lib/purchasedStore.ts";
import type { PlaylistTrack } from "../../src/shared/types.ts";

function track(uri: string, addedAt: string | null): PlaylistTrack {
	return {
		uri,
		name: uri,
		artists: [],
		album: { id: "a", name: "A", artists: [], imageUrl: null, totalTracks: 1 },
		addedAt,
		isLocal: false,
		position: 0,
	};
}

describe("purchasedStore", () => {
	test("parses only well-formed maps", () => {
		expect(parsePurchased(null)).toEqual({});
		expect(parsePurchased("not json")).toEqual({});
		expect(parsePurchased("[1,2]")).toEqual({});
		expect(parsePurchased('{"a":"2026-01-01T00:00:00.000Z","b":1}')).toEqual({ a: "2026-01-01T00:00:00.000Z" });
	});

	test("marks and unmarks tracks without touching others", () => {
		const now = new Date("2026-10-05T00:00:00Z");
		const marked = markPurchased({ x: "2026-01-01T00:00:00.000Z" }, ["a", "b"], now);
		expect(marked).toEqual({
			x: "2026-01-01T00:00:00.000Z",
			a: "2026-10-05T00:00:00.000Z",
			b: "2026-10-05T00:00:00.000Z",
		});
		expect(unmarkPurchased(marked, ["a", "missing"])).toEqual({
			x: "2026-01-01T00:00:00.000Z",
			b: "2026-10-05T00:00:00.000Z",
		});
	});

	test("forgets a mark when the track was re-added afterwards", () => {
		const map = { a: "2026-10-05T00:00:00.000Z" };
		expect(isPurchased(map, track("a", "2026-10-01T00:00:00Z"))).toBe(true);
		expect(isPurchased(map, track("a", "2026-10-05T00:00:00Z"))).toBe(true);
		expect(isPurchased(map, track("a", "2026-10-06T00:00:00Z"))).toBe(false);
		expect(isPurchased(map, track("a", null))).toBe(true);
		expect(isPurchased(map, track("b", null))).toBe(false);
	});
});
