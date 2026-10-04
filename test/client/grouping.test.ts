import { describe, expect, test } from "bun:test";
import { groupByAlbum } from "../../src/client/lib/grouping.ts";
import { moraRedirectUrl } from "../../src/client/lib/mora.ts";
import type { PlaylistTrack } from "../../src/shared/types.ts";

let position = 0;
function track(name: string, albumId: string | null, addedAt: string | null): PlaylistTrack {
	return {
		uri: `spotify:track:${name}`,
		name,
		artists: ["Artist"],
		album: { id: albumId, name: `Album ${albumId}`, artists: ["Artist"], imageUrl: null, totalTracks: 10 },
		addedAt,
		isLocal: albumId === null,
		position: position++,
	};
}

describe("groupByAlbum", () => {
	test("orders groups by their newest track and tracks newest first", () => {
		const items = [
			track("a1", "A", "2026-01-01T00:00:00Z"),
			track("b1", "B", "2026-02-01T00:00:00Z"),
			track("a2", "A", "2026-03-01T00:00:00Z"),
			track("c1", "C", null),
			track("b2", "B", "2026-01-15T00:00:00Z"),
		];
		const groups = groupByAlbum(items);
		expect(groups.map((g) => [g.key, g.latestAddedAt, g.tracks.map((t) => t.name)])).toEqual([
			["A", "2026-03-01T00:00:00Z", ["a2", "a1"]],
			["B", "2026-02-01T00:00:00Z", ["b1", "b2"]],
			["C", null, ["c1"]],
		]);
	});

	test("keeps playlist order for tracks added at the same time", () => {
		const items = [
			track("x1", "X", "2026-01-01T00:00:00Z"),
			track("x2", "X", "2026-01-01T00:00:00Z"),
			track("x3", "X", "2026-01-01T00:00:00Z"),
		];
		expect(groupByAlbum(items)[0]!.tracks.map((t) => t.name)).toEqual(["x1", "x2", "x3"]);
	});

	test("groups local files by album name", () => {
		const groups = groupByAlbum([track("l1", null, null), track("l2", null, null)]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.key).toBe("local:Album null");
	});
});

describe("moraRedirectUrl", () => {
	test("carries track, album and artists", () => {
		const url = new URL(moraRedirectUrl({ ...track("Song", "A", null), artists: ["X", "Y"] }), "https://app.test");
		expect(url.pathname).toBe("/mora/redirect");
		expect(url.searchParams.get("title")).toBe("Song");
		expect(url.searchParams.get("album")).toBe("Album A");
		expect(url.searchParams.getAll("artist")).toEqual(["X", "Y"]);
		expect(url.searchParams.getAll("albumArtist")).toEqual(["Artist"]);
		expect(url.searchParams.get("tracks")).toBe("10");
	});

	test("truncates overlong values to the redirector's limits", () => {
		const url = new URL(moraRedirectUrl({ ...track("x".repeat(300), "A", null) }), "https://app.test");
		expect(url.searchParams.get("title")).toHaveLength(200);
	});
});
