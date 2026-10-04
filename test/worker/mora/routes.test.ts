import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import app from "../../../src/worker/index.ts";
import type { MoraQuery } from "../../../src/worker/mora/match.ts";
import { formatLabel } from "../../../src/worker/mora/routes.ts";
import type { Session } from "../../../src/worker/session.ts";
import { MORA_CASES } from "../../fixtures/mora/cases.ts";
import { replayMoraFixtures } from "../../fixtures/mora/replay.ts";
import { sessionCookie } from "../../helpers/cookies.ts";
import { ORIGIN, TEST_ENV } from "../../helpers/env.ts";
import { mockFetch } from "../../helpers/fetchMock.ts";

afterEach(() => mock.restore());

// An expired access token is fine: the redirector never calls Spotify.
const SESSION: Session = { accessToken: "at", refreshToken: "rt", expiresAt: 0 };

function redirectPath(query: MoraQuery, extra: Record<string, string> = {}) {
	const params = new URLSearchParams({ title: query.title, album: query.album });
	for (const artist of query.artists) params.append("artist", artist);
	for (const artist of query.albumArtists) params.append("albumArtist", artist);
	if (query.totalTracks !== null) params.set("tracks", String(query.totalTracks));
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	return `/mora/redirect?${params}`;
}

async function request(path: string, withSession = true) {
	const headers: Record<string, string> = withSession ? { Cookie: await sessionCookie(SESSION) } : {};
	return app.request(`${ORIGIN}${path}`, { headers }, TEST_ENV);
}

function packageHit(overrides: Record<string, unknown>) {
	return {
		artistName: "Artist",
		artistNameKana: null,
		packageTitle: "Album",
		packageId: "PKG-1",
		labelCode: "43000001",
		mediaFormatNo: 10,
		samplingFreq: 44100,
		bitPerSample: null,
		packageTrack: 10,
		startDate: "2024/01/01 00:00:00",
		...overrides,
	};
}

function serveSinglePackage(overrides: Record<string, unknown> = {}) {
	return mockFetch((request) => {
		const kind = new URL(request.url).searchParams.get("searchKind");
		const list = kind === "02" ? [packageHit(overrides)] : [];
		const section = { resultCode: list.length ? "SM0305000" : "EM0305200", total: list.length, list };
		return new Response(JSON.stringify({ data: kind === "02" ? { packageResult: section } : { trackResult: section } }));
	});
}

const ALBUM_QUERY: MoraQuery = {
	title: "Song",
	artists: ["Artist"],
	album: "Album",
	albumArtists: ["Artist"],
	totalTracks: 10,
};

describe("GET /mora/redirect", () => {
	test("sends visitors without a session through login and back", async () => {
		const path = redirectPath(MORA_CASES.lemonSingle);
		const response = await request(path, false);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!, ORIGIN);
		expect(location.pathname).toBe("/auth/login");
		expect(location.searchParams.get("return_to")).toBe(path);
	});

	test("redirects straight to mora when there is a single edition", async () => {
		serveSinglePackage();
		const response = await request(redirectPath(ALBUM_QUERY));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://mora.jp/package/43000001/PKG-1/");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	test("lets the user choose between editions", async () => {
		await replayMoraFixtures();
		const response = await request(redirectPath(MORA_CASES.lemonSingle));
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toStartWith("text/html");
		const body = await response.text();
		expect(body).toContain('href="https://mora.jp/package/43000087/SRCL09749B00Z/?trackMaterialNo=11467222"');
		expect(body).toContain('href="https://mora.jp/package/43000188/SRCL09749B00Z/?trackMaterialNo=30195061"');
		expect(body).toContain('href="https://mora.jp/package/43000100/SRCL09749B00Z_48/?trackMaterialNo=21286729"');
		expect(body).toContain("Hi-Res FLAC 24bit/48kHz");
		expect(body).toContain("Lossless FLAC 16bit/44.1kHz");
		expect(body).toContain("3 tracks, released 2018/03/14");
	});

	test("escapes mora and Spotify text in the chooser", async () => {
		mockFetch((request) => {
			const kind = new URL(request.url).searchParams.get("searchKind");
			const list =
				kind === "02"
					? [
							packageHit({ packageTitle: "<b>Album</b>" }),
							packageHit({ packageTitle: "<b>Album</b>", packageId: "PKG-1_HD", mediaFormatNo: 12, samplingFreq: 96000, bitPerSample: "24" }),
						]
					: [];
			const section = { resultCode: "SM0305000", total: list.length, list };
			return new Response(JSON.stringify({ data: kind === "02" ? { packageResult: section } : { trackResult: section } }));
		});
		const response = await request(redirectPath({ ...ALBUM_QUERY, title: "<script>x</script>", album: "<b>Album</b>" }));
		const body = await response.text();
		expect(body).not.toContain("<script>x");
		expect(body).not.toContain("<b>Album");
		expect(body).toContain("&lt;b&gt;Album&lt;/b&gt;");
	});

	test("falls back to mora search when nothing matches", async () => {
		await replayMoraFixtures();
		const response = await request(redirectPath(MORA_CASES.unknown));
		expect(response.headers.get("Location")).toBe(
			"https://mora.jp/search/top?keyWord=Nobody+Qwxz+Nonexistent+Song+Zzyzx",
		);
	});

	test("falls back to mora search when mora misbehaves", async () => {
		mockFetch(() => new Response(null, { status: 302, headers: { Location: "https://mora.jp/unsupported" } }));
		spyOn(console, "error").mockImplementation(() => {});
		const response = await request(redirectPath(ALBUM_QUERY));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://mora.jp/search/top?keyWord=Artist+Song");
	});

	test("explains its decision with debug=1", async () => {
		await replayMoraFixtures();
		const response = await request(redirectPath(MORA_CASES.lemonSingle, { debug: "1" }));
		const body = (await response.json()) as { kind: string; debug: { queries: string[] } };
		expect(body.kind).toBe("editions");
		expect(body.debug.queries[0]).toBe("packages: 米津玄師 Lemon");
	});

	test.each([
		["missing title", { ...ALBUM_QUERY, title: "" }],
		["overlong title", { ...ALBUM_QUERY, title: "x".repeat(201) }],
		["too many artists", { ...ALBUM_QUERY, artists: Array.from({ length: 11 }, (_, i) => `a${i}`) }],
	])("rejects %s", async (_, query) => {
		const requests = mockFetch(() => new Response("{}"));
		const response = await request(redirectPath(query));
		expect(response.status).toBe(400);
		expect(requests).toHaveLength(0);
	});
});

describe("formatLabel", () => {
	const edition = {
		url: "",
		labelCode: "",
		packageId: "",
		packageTitle: "",
		artistName: "",
		packageTrack: null,
		startDate: "",
		trackMaterialNo: null,
	};

	test.each([
		[{ mediaFormatNo: 10, samplingFreq: 44100, bitPerSample: null }, "AAC 320kbps"],
		[{ mediaFormatNo: 15, samplingFreq: 44100, bitPerSample: "16" }, "Lossless FLAC 16bit/44.1kHz"],
		[{ mediaFormatNo: 12, samplingFreq: 192000, bitPerSample: "24" }, "Hi-Res FLAC 24bit/192kHz"],
		[{ mediaFormatNo: 13, samplingFreq: 2822400, bitPerSample: "1" }, "DSD 2.8MHz"],
		[{ mediaFormatNo: 99, samplingFreq: null, bitPerSample: null }, "Format 99"],
	])("%p -> %p", (format, label) => {
		expect(formatLabel({ ...edition, ...format })).toBe(label);
	});
});
