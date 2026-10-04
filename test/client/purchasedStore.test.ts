import { describe, expect, test } from "bun:test";
import { groupByAlbum } from "../../src/client/lib/grouping.ts";
import {
	isPurchased,
	markPurchased,
	parsePurchased,
	pickPurchased,
	purchasedGroups,
	restorePurchased,
	unmarkPurchased,
} from "../../src/client/lib/purchasedStore.ts";
import type { PlaylistTrack } from "../../src/shared/types.ts";

function track(uri: string, addedAt: string | null, albumId = "a", position = 0): PlaylistTrack {
	return {
		uri,
		name: uri,
		artists: [],
		album: { id: albumId, name: albumId, artists: [], imageUrl: null, totalTracks: 1 },
		durationMs: null,
		trackNumber: null,
		discNumber: null,
		isrc: null,
		addedAt,
		isLocal: false,
		position,
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

	test("restores picked marks with their original times, keeping newer marks", () => {
		const map = { a: "2026-10-01T00:00:00.000Z", b: "2026-10-02T00:00:00.000Z", x: "2026-01-01T00:00:00.000Z" };
		const picked = pickPurchased(map, ["a", "b", "missing"]);
		expect(picked).toEqual({ a: "2026-10-01T00:00:00.000Z", b: "2026-10-02T00:00:00.000Z" });
		const remarked = markPurchased(unmarkPurchased(map, ["a", "b"]), ["b"], new Date("2026-10-05T00:00:00Z"));
		expect(restorePurchased(remarked, picked)).toEqual({
			a: "2026-10-01T00:00:00.000Z",
			b: "2026-10-05T00:00:00.000Z",
			x: "2026-01-01T00:00:00.000Z",
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

	test("lists purchased tracks by album, most recently marked first", () => {
		const groups = groupByAlbum([
			track("a1", "2026-10-03T00:00:00Z", "A", 0),
			track("a2", "2026-10-02T00:00:00Z", "A", 1),
			track("b1", "2026-10-01T00:00:00Z", "B", 2),
			track("b1", "2026-10-01T00:00:00Z", "B", 3),
			track("c1", "2026-10-01T00:00:00Z", "C", 4),
		]);
		const map = {
			a2: "2026-10-04T00:00:00.000Z",
			b1: "2026-10-05T00:00:00.000Z",
			c1: "2026-09-30T00:00:00.000Z",
		};
		expect(purchasedGroups(groups, map).map((g) => [g.key, g.tracks.map((t) => t.uri)])).toEqual([
			["B", ["b1"]],
			["A", ["a2"]],
		]);
	});
});
