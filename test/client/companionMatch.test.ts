import { describe, expect, test } from "bun:test";
import {
	type CheckClient,
	checkLibrary,
	dismissMatch,
	localMatchView,
	type MatchCache,
	moraPackageUrl,
	NoCommonProtocolError,
	parseMatchCache,
	parsePairing,
	summarizeMatches,
	toCompanionTracks,
	unmarkedOwnedUris,
	updateMatchCache,
} from "../../src/client/lib/companionMatch.ts";
import {
	type CompanionStatus,
	type CompanionTrack,
	type LocalMatch,
	type MatchResult,
	negotiateProtocol,
} from "../../src/client/lib/companionProtocol.ts";
import type { PlaylistTrack } from "../../src/shared/types.ts";

function track(uri: string, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
	return {
		uri,
		name: `Song ${uri}`,
		artists: ["Artist"],
		album: { id: "album1", name: "Album", artists: ["Album Artist"], imageUrl: null, totalTracks: 12 },
		durationMs: 200000,
		trackNumber: 3,
		discNumber: 1,
		isrc: "JPXX02600001",
		addedAt: "2026-10-01T00:00:00Z",
		isLocal: false,
		position: 0,
		...overrides,
	};
}

function localMatch(id: string, overrides: Partial<LocalMatch> = {}): LocalMatch {
	return {
		source: "itunes",
		id,
		title: "Song",
		artists: ["Artist"],
		album: "Album",
		durationMs: 200000,
		ownership: "purchased",
		format: "AAC",
		cloudOnly: false,
		location: "iTunes · Artist / Album",
		metadataSource: "tags",
		ids: {},
		score: 0.9,
		signals: { title: 1, artist: 1, album: 1, durationDeltaMs: 0, isrc: null },
		...overrides,
	};
}

function result(key: string, verdict: MatchResult["verdict"], matchIds: string[] = []): MatchResult {
	return {
		key,
		verdict,
		score: verdict === "absent" ? 0.2 : 0.9,
		matchedBy: verdict === "absent" ? null : "metadata",
		matches: matchIds.map((id) => localMatch(id)),
	};
}

function status(libraryRevision: string, protocols = [1]): CompanionStatus {
	return {
		protocols,
		version: "0.1.0",
		libraryRevision,
		capabilities: ["match"],
		sources: [{ id: "itunes", label: "iTunes", state: "ready", entries: 10, indexedAt: null }],
	};
}

function companionTracks(count: number): CompanionTrack[] {
	return toCompanionTracks(Array.from({ length: count }, (_, i) => track(`spotify:track:${i}`)));
}

// Answers every track as absent, at the revisions given in order (the last one repeats).
function fakeClient(revisions: string[], matchRevisions: string[] = revisions) {
	const calls = { status: 0, match: [] as { protocol: number; keys: string[] }[] };
	const client: CheckClient = {
		status: async () => status(revisions[Math.min(calls.status++, revisions.length - 1)]!),
		match: async (protocol, tracks) => {
			const revision = matchRevisions[Math.min(calls.match.length, matchRevisions.length - 1)]!;
			calls.match.push({ protocol, keys: tracks.map((t) => t.key) });
			return { protocol, libraryRevision: revision, results: tracks.map((t) => result(t.key, "absent")) };
		},
	};
	return { client, calls };
}

describe("negotiateProtocol", () => {
	test("picks the highest common version", () => {
		expect(negotiateProtocol([1, 2])).toBe(1);
		expect(negotiateProtocol([2, 3])).toBeNull();
		expect(negotiateProtocol(undefined)).toBeNull();
	});
});

describe("parsePairing", () => {
	test("accepts only a non-empty token", () => {
		expect(parsePairing('{"token":"abc"}')).toEqual({ token: "abc" });
		expect(parsePairing('{"token":""}')).toBeNull();
		expect(parsePairing('"abc"')).toBeNull();
		expect(parsePairing("not json")).toBeNull();
		expect(parsePairing(null)).toBeNull();
	});
});

describe("parseMatchCache", () => {
	test("requires a revision and results, and drops malformed dismissals", () => {
		expect(parseMatchCache('{"results":{}}')).toBeNull();
		expect(parseMatchCache('{"libraryRevision":"r1","results":{},"dismissed":{"a":"m1","b":2}}')).toEqual({
			libraryRevision: "r1",
			results: {},
			dismissed: { a: "m1" },
		});
		expect(parseMatchCache('{"libraryRevision":"r1","results":{}}')?.dismissed).toEqual({});
	});
});

describe("toCompanionTracks", () => {
	test("maps playlist tracks, dropping local files and duplicate URIs", () => {
		const tracks = toCompanionTracks([
			track("spotify:track:a"),
			track("spotify:track:a", { position: 5 }),
			track("spotify:local:x", { isLocal: true }),
		]);
		expect(tracks).toEqual([
			{
				key: "spotify:track:a",
				title: "Song spotify:track:a",
				artists: ["Artist"],
				album: { id: "album1", title: "Album", artists: ["Album Artist"], totalTracks: 12 },
				durationMs: 200000,
				isrc: "JPXX02600001",
				trackNumber: 3,
				discNumber: 1,
			},
		]);
	});
});

describe("checkLibrary", () => {
	test("chunks requests to 500 tracks with the negotiated protocol", async () => {
		const { client, calls } = fakeClient(["r1"]);
		const check = await checkLibrary(companionTracks(1001), null, client);
		expect(calls.match.map((call) => [call.protocol, call.keys.length])).toEqual([
			[1, 500],
			[1, 500],
			[1, 1],
		]);
		expect(check.libraryRevision).toBe("r1");
		expect(check.results.size).toBe(1001);
	});

	test("asks only about tracks without a cached result at the same revision", async () => {
		const cache: MatchCache = {
			libraryRevision: "r1",
			results: { "spotify:track:0": result("spotify:track:0", "owned", ["m0"]) },
			dismissed: {},
		};
		const { client, calls } = fakeClient(["r1"]);
		const check = await checkLibrary(companionTracks(2), cache, client);
		expect(calls.match.map((call) => call.keys)).toEqual([["spotify:track:1"]]);
		expect(check.results.get("spotify:track:0")?.verdict).toBe("owned");
		expect(check.results.get("spotify:track:1")?.verdict).toBe("absent");
	});

	test("ignores the cache from another library revision", async () => {
		const cache: MatchCache = {
			libraryRevision: "r0",
			results: { "spotify:track:0": result("spotify:track:0", "owned", ["m0"]) },
			dismissed: {},
		};
		const { client, calls } = fakeClient(["r1"]);
		const check = await checkLibrary(companionTracks(1), cache, client);
		expect(calls.match).toHaveLength(1);
		expect(check.results.get("spotify:track:0")?.verdict).toBe("absent");
	});

	test("restarts when the revision changes mid-check", async () => {
		const { client, calls } = fakeClient(["r1", "r2"], ["r2"]);
		const check = await checkLibrary(companionTracks(1), null, client);
		expect(calls.status).toBe(2);
		expect(check.libraryRevision).toBe("r2");
	});

	test("gives up when the revision keeps changing", async () => {
		const { client } = fakeClient(["r1"], ["r2"]);
		await expect(checkLibrary(companionTracks(1), null, client)).rejects.toThrow("kept changing");
	});

	test("ignores results for keys it didn't ask about", async () => {
		const client: CheckClient = {
			status: async () => status("r1"),
			match: async (protocol) => ({
				protocol,
				libraryRevision: "r1",
				results: [result("spotify:track:0", "owned", ["m0"]), result("spotify:track:other", "owned", ["m1"])],
			}),
		};
		const check = await checkLibrary(companionTracks(1), null, client);
		expect([...check.results.keys()]).toEqual(["spotify:track:0"]);
	});

	test("fails without a common protocol", async () => {
		const client: CheckClient = { status: async () => status("r1", [2]), match: async () => ({}) as never };
		await expect(checkLibrary(companionTracks(1), null, client)).rejects.toBeInstanceOf(NoCommonProtocolError);
	});
});

describe("updateMatchCache", () => {
	test("keeps results and dismissals only for the checked tracks", () => {
		const previous: MatchCache = {
			libraryRevision: "r0",
			results: {},
			dismissed: { "spotify:track:a": "m1", "spotify:track:gone": "m2" },
		};
		const a = result("spotify:track:a", "probable", ["m1"]);
		const cache = updateMatchCache(previous, { libraryRevision: "r1", results: new Map([[a.key, a]]) });
		expect(cache).toEqual({
			libraryRevision: "r1",
			results: { "spotify:track:a": a },
			dismissed: { "spotify:track:a": "m1" },
		});
	});
});

describe("unmarkedOwnedUris", () => {
	test("returns owned tracks that aren't marked or dismissed, once each", () => {
		const cache: MatchCache = {
			libraryRevision: "r1",
			results: {
				"spotify:track:a": result("spotify:track:a", "owned", ["m1"]),
				"spotify:track:b": result("spotify:track:b", "owned", ["m2"]),
				"spotify:track:c": result("spotify:track:c", "probable", ["m3"]),
				"spotify:track:d": result("spotify:track:d", "owned", ["m4"]),
				"spotify:track:e": result("spotify:track:e", "owned", ["m6", "m5"]),
			},
			dismissed: { "spotify:track:d": "m4", "spotify:track:e": "m5" },
		};
		const items = [
			track("spotify:track:a"),
			track("spotify:track:a", { position: 1 }),
			track("spotify:track:b"),
			track("spotify:track:c"),
			track("spotify:track:d"),
			track("spotify:track:e"),
		];
		expect(unmarkedOwnedUris(cache, items, { "spotify:track:b": "2026-10-02T00:00:00Z" })).toEqual([
			"spotify:track:a",
			"spotify:track:e",
		]);
	});
});

describe("localMatchView", () => {
	const cache: MatchCache = {
		libraryRevision: "r1",
		results: {
			"spotify:track:owned": result("spotify:track:owned", "owned", ["m1"]),
			"spotify:track:probable": result("spotify:track:probable", "probable", ["m2", "m3"]),
			"spotify:track:dismissed": result("spotify:track:dismissed", "probable", ["m4"]),
			"spotify:track:redismissed": result("spotify:track:redismissed", "probable", ["m6", "m5"]),
			"spotify:track:absent": result("spotify:track:absent", "absent"),
		},
		dismissed: { "spotify:track:dismissed": "m4", "spotify:track:redismissed": "m5" },
	};

	test("shows owned tracks whether or not they are marked, until dismissed", () => {
		expect(localMatchView(cache, track("spotify:track:owned"), true)).toMatchObject({
			kind: "owned",
			match: { id: "m1" },
		});
		const dismissed = dismissMatch(cache, "spotify:track:owned", "m1");
		expect(localMatchView(dismissed, track("spotify:track:owned"), false)).toBeNull();
	});

	test("offers the best probable match for review until it is marked or dismissed", () => {
		expect(localMatchView(cache, track("spotify:track:probable"), false)).toMatchObject({
			kind: "review",
			match: { id: "m2" },
			matchedBy: "metadata",
		});
		expect(localMatchView(cache, track("spotify:track:probable"), true)).toBeNull();
		expect(localMatchView(cache, track("spotify:track:dismissed"), false)).toBeNull();
	});

	test("shows a probable track again when a different match becomes the best one", () => {
		expect(localMatchView(cache, track("spotify:track:redismissed"), false)).toMatchObject({ match: { id: "m6" } });
	});

	test("shows nothing for absent, unchecked or local tracks", () => {
		expect(localMatchView(cache, track("spotify:track:absent"), false)).toBeNull();
		expect(localMatchView(cache, track("spotify:track:unknown"), false)).toBeNull();
		expect(localMatchView(cache, track("spotify:track:owned", { isLocal: true }), false)).toBeNull();
	});

	test("hides a review once dismissed", () => {
		const dismissed = dismissMatch(cache, "spotify:track:probable", "m2");
		expect(localMatchView(dismissed, track("spotify:track:probable"), false)).toBeNull();
	});
});

describe("summarizeMatches", () => {
	test("counts unique checked, owned and reviewable tracks", () => {
		const cache: MatchCache = {
			libraryRevision: "r1",
			results: {
				"spotify:track:a": result("spotify:track:a", "owned", ["m1"]),
				"spotify:track:b": result("spotify:track:b", "probable", ["m2"]),
				"spotify:track:c": result("spotify:track:c", "probable", ["m3"]),
				"spotify:track:d": result("spotify:track:d", "absent"),
			},
			dismissed: {},
		};
		const items = [
			track("spotify:track:a"),
			track("spotify:track:a", { position: 1 }),
			track("spotify:track:b"),
			track("spotify:track:c"),
			track("spotify:track:d"),
			track("spotify:track:unchecked"),
		];
		expect(summarizeMatches(cache, items, { "spotify:track:c": "2026-10-02T00:00:00Z" })).toEqual({
			checked: 4,
			owned: 1,
			toReview: 1,
		});
	});
});

describe("moraPackageUrl", () => {
	test("links the package and highlights the track", () => {
		const match = localMatch("m1", {
			ids: { mora: { labelCode: "10006001", packageId: "TCJPS0003693263_hires", materialNo: "35843225" } },
		});
		expect(moraPackageUrl(match)).toBe(
			"https://mora.jp/package/10006001/TCJPS0003693263_hires/?trackMaterialNo=35843225",
		);
		expect(moraPackageUrl(localMatch("m2"))).toBeNull();
	});
});
