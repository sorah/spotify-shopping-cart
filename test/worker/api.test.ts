import { afterEach, describe, expect, mock, test } from "bun:test";
import app from "../../src/worker/index.ts";
import { formatDescription } from "../../src/worker/lastShopping.ts";
import type { Session } from "../../src/worker/session.ts";
import { normalizeItemsPage, type SpotifyItemsPage } from "../../src/worker/spotify.ts";
import { sessionCookie, setCookies } from "../helpers/cookies.ts";
import { ORIGIN, TEST_ENV } from "../helpers/env.ts";
import { type FetchHandler, jsonResponse, mockFetch } from "../helpers/fetchMock.ts";

afterEach(() => mock.restore());

const PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M";
const SESSION: Session = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 };

async function request(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cookie", await sessionCookie(SESSION));
	return app.request(`${ORIGIN}${path}`, { ...init, headers }, TEST_ENV);
}

function postRemove(body: unknown, headers: Record<string, string> = {}) {
	return request(`/api/playlists/${PLAYLIST_ID}/remove`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers },
		body: JSON.stringify(body),
	});
}

function putLastShopping(body: unknown) {
	return request(`/api/playlists/${PLAYLIST_ID}/last-shopping`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
		body: JSON.stringify(body),
	});
}

function track(id: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "track",
		uri: `spotify:track:${id}`,
		name: `Song ${id}`,
		is_local: false,
		artists: [{ name: "Artist" }],
		album: {
			id: "album1",
			name: "Album",
			total_tracks: 10,
			images: [
				{ url: "https://i.test/640", width: 640 },
				{ url: "https://i.test/300", width: 300 },
				{ url: "https://i.test/64", width: 64 },
			],
			artists: [{ name: "Album Artist" }],
		},
		...overrides,
	};
}

const uri = (n: number) => `spotify:track:${String(n).padStart(22, "0")}`;

describe("GET /api/me", () => {
	test("returns the profile with the Spotify token", async () => {
		const requests = mockFetch(() => jsonResponse({ id: "u1", display_name: "User" }));
		const response = await request("/api/me");
		expect(await response.json()).toEqual({ id: "u1", displayName: "User" });
		expect(requests[0]!.url).toBe("https://api.spotify.com/v1/me");
		expect(requests[0]!.headers.get("Authorization")).toBe("Bearer at");
		expect(requests[0]!.headers.get("Accept-Language")).toBe("ja");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	test("reports users missing from the Development Mode allowlist", async () => {
		mockFetch(() => jsonResponse({ error: { status: 403 } }, { status: 403 }));
		const response = await request("/api/me");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "not_allowlisted" });
	});

	test("refreshes and retries once when Spotify rejects the token", async () => {
		const handler: FetchHandler = (req) => {
			if (req.url === "https://accounts.spotify.com/api/token") {
				return jsonResponse({ access_token: "at2", token_type: "Bearer", scope: "", expires_in: 3600 });
			}
			return req.headers.get("Authorization") === "Bearer at2"
				? jsonResponse({ id: "u1", display_name: null })
				: jsonResponse({}, { status: 401 });
		};
		const requests = mockFetch(handler);
		const response = await request("/api/me");
		expect(await response.json()).toEqual({ id: "u1", displayName: null });
		expect(requests.map((r) => r.url)).toEqual([
			"https://api.spotify.com/v1/me",
			"https://accounts.spotify.com/api/token",
			"https://api.spotify.com/v1/me",
		]);
		expect(setCookies(response).has("__Host-ssc_session")).toBe(true);
	});

	test("passes rate limits through", async () => {
		mockFetch(() => jsonResponse({}, { status: 429, headers: { "Retry-After": "7" } }));
		const response = await request("/api/me");
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("7");
		expect(await response.json()).toEqual({ code: "rate_limited" });
	});

	test("requires a session", async () => {
		const response = await app.request(`${ORIGIN}/api/me`, {}, TEST_ENV);
		expect(response.status).toBe(401);
	});
});

describe("GET /api/playlists/:id", () => {
	test("returns playlist metadata", async () => {
		const requests = mockFetch(() =>
			jsonResponse({
				id: PLAYLIST_ID,
				name: "Cart",
				owner: { id: "u1", display_name: "User" },
				collaborative: false,
				images: null,
				external_urls: { spotify: `https://open.spotify.com/playlist/${PLAYLIST_ID}` },
			}),
		);
		const response = await request(`/api/playlists/${PLAYLIST_ID}`);
		expect(await response.json()).toEqual({
			id: PLAYLIST_ID,
			name: "Cart",
			ownerId: "u1",
			ownerName: "User",
			collaborative: false,
			imageUrl: null,
			externalUrl: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
			lastShopping: null,
		});
		const url = new URL(requests[0]!.url);
		expect(url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}`);
		expect(url.searchParams.has("market")).toBe(false);
	});

	test("reads the last shopping record from the description", async () => {
		const lastShopping = { at: "2026-10-05T00:00:00.000Z", songCount: 3 };
		const requests = mockFetch(() =>
			jsonResponse({
				id: PLAYLIST_ID,
				name: "Cart",
				description: formatDescription("Songs to buy", lastShopping, "UTC"),
				owner: { id: "u1", display_name: "User" },
				collaborative: false,
				images: null,
				external_urls: { spotify: `https://open.spotify.com/playlist/${PLAYLIST_ID}` },
			}),
		);
		const response = await request(`/api/playlists/${PLAYLIST_ID}`);
		expect(await response.json()).toMatchObject({ lastShopping });
		expect(new URL(requests[0]!.url).searchParams.get("fields")).toContain("description");
	});

	test("rejects malformed ids before calling Spotify", async () => {
		const requests = mockFetch(() => jsonResponse({}));
		const response = await request("/api/playlists/not-an-id");
		expect(response.status).toBe(400);
		expect(requests).toHaveLength(0);
	});
});

describe("GET /api/playlists/:id/items", () => {
	test("requests a filtered page without a market", async () => {
		const requests = mockFetch(() => jsonResponse({ next: null, total: 0, items: [] }));
		const response = await request(`/api/playlists/${PLAYLIST_ID}/items?offset=50`);
		expect(await response.json()).toEqual({ items: [], nextOffset: null, total: 0 });
		const url = new URL(requests[0]!.url);
		expect(url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}/items`);
		expect(url.searchParams.get("offset")).toBe("50");
		expect(url.searchParams.get("limit")).toBe("50");
		expect(url.searchParams.get("fields")).toContain("item(");
		expect(url.searchParams.get("fields")).toContain("track(");
		expect(url.searchParams.has("market")).toBe(false);
	});

	test("explains the owner/collaborator restriction on 403", async () => {
		mockFetch(() => jsonResponse({}, { status: 403 }));
		const response = await request(`/api/playlists/${PLAYLIST_ID}/items`);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "playlist_forbidden" });
	});

	test("rejects invalid offsets", async () => {
		const response = await request(`/api/playlists/${PLAYLIST_ID}/items?offset=-1`);
		expect(response.status).toBe(400);
	});
});

describe("normalizeItemsPage", () => {
	const page: SpotifyItemsPage = {
		next: "https://api.spotify.com/v1/playlists/x/items?offset=54",
		total: 120,
		items: [
			{ added_at: "2026-10-01T00:00:00Z", item: track("A".repeat(22)) as never },
			{ added_at: "2026-10-02T00:00:00Z", track: track("B".repeat(22)) as never },
			{ added_at: "2026-10-03T00:00:00Z", item: { type: "episode" } },
			{ added_at: "2026-10-04T00:00:00Z", item: null, track: null },
			{
				added_at: null,
				is_local: true,
				item: track("", {
					uri: "spotify:local:Artist:Local+Album:Local+Song:180",
					name: "Local Song",
					is_local: true,
					album: { id: null, name: "Local Album", images: [], artists: [] },
				}) as never,
			},
		],
	};

	test("keeps tracks from either item or track and drops episodes and unavailable items", () => {
		const result = normalizeItemsPage(page, 50);
		expect(result.nextOffset).toBe(55);
		expect(result.total).toBe(120);
		expect(result.items.map((item) => [item.uri, item.position])).toEqual([
			[`spotify:track:${"A".repeat(22)}`, 50],
			[`spotify:track:${"B".repeat(22)}`, 51],
			["spotify:local:Artist:Local+Album:Local+Song:180", 54],
		]);
	});

	test("normalizes track and album details", () => {
		const [first, , local] = normalizeItemsPage(page, 0).items;
		expect(first).toEqual({
			uri: `spotify:track:${"A".repeat(22)}`,
			name: `Song ${"A".repeat(22)}`,
			artists: ["Artist"],
			album: {
				id: "album1",
				name: "Album",
				artists: ["Album Artist"],
				imageUrl: "https://i.test/300",
				totalTracks: 10,
			},
			addedAt: "2026-10-01T00:00:00Z",
			isLocal: false,
			position: 0,
		});
		expect(local).toMatchObject({ isLocal: true, addedAt: null, album: { id: null, imageUrl: null } });
	});

	test("ends pagination when there is no next page", () => {
		expect(normalizeItemsPage({ ...page, next: null }, 0).nextOffset).toBeNull();
	});
});

describe("POST /api/playlists/:id/remove", () => {
	test("dedupes and removes in chunks of 100", async () => {
		let n = 0;
		const requests = mockFetch(() => jsonResponse({ snapshot_id: `snap${++n}` }));
		const uris = [...Array.from({ length: 230 }, (_, i) => uri(i)), uri(0), uri(1)];
		const response = await postRemove({ uris });
		expect(await response.json()).toEqual({ snapshotId: "snap3", removed: 230 });

		expect(requests).toHaveLength(3);
		const bodies = await Promise.all(requests.map(async (r) => (await r.json()) as { items: { uri: string }[] }));
		expect(bodies.map((b) => b.items.length)).toEqual([100, 100, 30]);
		expect(bodies[0]!.items[0]).toEqual({ uri: uri(0) });
		expect(requests[0]!.method).toBe("DELETE");
		expect(new URL(requests[0]!.url).pathname).toBe(`/v1/playlists/${PLAYLIST_ID}/items`);
	});

	test.each([
		[{}],
		[{ uris: [] }],
		[{ uris: ["spotify:episode:0000000000000000000000"] }],
		[{ uris: ["spotify:local:a:b:c:1"] }],
		[{ uris: Array.from({ length: 501 }, (_, i) => uri(i)) }],
	])("rejects invalid bodies %#", async (body) => {
		const requests = mockFetch(() => jsonResponse({}));
		const response = await postRemove(body);
		expect(response.status).toBe(400);
		expect(requests).toHaveLength(0);
	});

	test("requires a JSON content type", async () => {
		const response = await postRemove({ uris: [uri(1)] }, { "Content-Type": "text/plain" });
		expect(response.status).toBe(415);
	});

	test("rejects cross-site requests", async () => {
		const response = await postRemove({ uris: [uri(1)] }, { "Sec-Fetch-Site": "cross-site" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "cross_origin_request" });
	});

	test("explains the owner/collaborator restriction on 403", async () => {
		mockFetch(() => jsonResponse({}, { status: 403 }));
		const response = await postRemove({ uris: [uri(1)] });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "playlist_forbidden" });
	});
});

describe("PUT /api/playlists/:id/last-shopping", () => {
	test("rewrites the description with the new record", async () => {
		const requests = mockFetch((req) =>
			req.method === "GET" ? jsonResponse({ description: "Songs &amp; albums to buy" }) : new Response(null),
		);
		const before = Date.now();
		const response = await putLastShopping({ songCount: 4, timeZone: "Asia/Tokyo" });
		const body = (await response.json()) as { at: string; songCount: number };
		expect(body.songCount).toBe(4);
		expect(Date.parse(body.at)).toBeGreaterThanOrEqual(before);

		expect(requests.map((r) => r.method)).toEqual(["GET", "PUT"]);
		const url = new URL(requests[0]!.url);
		expect(url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}`);
		expect(url.searchParams.get("fields")).toBe("description");
		expect(requests[1]!.url).toBe(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}`);
		expect(await requests[1]!.json()).toEqual({
			description: formatDescription("Songs & albums to buy", body, "Asia/Tokyo"),
		});
	});

	test.each([
		[{ timeZone: "UTC" }],
		[{ songCount: 0, timeZone: "UTC" }],
		[{ songCount: 1.5, timeZone: "UTC" }],
		[{ songCount: 1 }],
		[{ songCount: 1, timeZone: "Mars/Olympus_Mons" }],
	])("rejects invalid bodies %#", async (body) => {
		const requests = mockFetch(() => jsonResponse({}));
		const response = await putLastShopping(body);
		expect(response.status).toBe(400);
		expect(requests).toHaveLength(0);
	});

	test("reports playlists the user cannot edit", async () => {
		mockFetch((req) => (req.method === "GET" ? jsonResponse({ description: "" }) : jsonResponse({}, { status: 403 })));
		const response = await putLastShopping({ songCount: 1, timeZone: "UTC" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "playlist_forbidden" });
	});
});
