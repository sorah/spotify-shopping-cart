import { afterEach, describe, expect, mock, test } from "bun:test";
import { sanitizeReturnTo } from "../../src/worker/auth.ts";
import { unseal } from "../../src/worker/cookieCrypto.ts";
import app from "../../src/worker/index.ts";
import type { Session } from "../../src/worker/session.ts";
import { cookieHeader, setCookies } from "../helpers/cookies.ts";
import { ORIGIN, TEST_ENV } from "../helpers/env.ts";
import { jsonResponse, mockFetch } from "../helpers/fetchMock.ts";

afterEach(() => mock.restore());

async function startLogin(returnTo?: string) {
	const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
	const response = await app.request(`${ORIGIN}/auth/login${query}`, {}, TEST_ENV);
	const location = new URL(response.headers.get("Location")!);
	const stateCookie = setCookies(response).get("__Host-ssc_state")!;
	return { response, location, stateCookie };
}

function callback(params: Record<string, string>, stateCookie?: string) {
	return app.request(
		`${ORIGIN}/auth/callback?${new URLSearchParams(params)}`,
		{ headers: stateCookie ? { Cookie: cookieHeader({ "__Host-ssc_state": stateCookie }) } : {} },
		TEST_ENV,
	);
}

describe("GET /auth/login", () => {
	test("redirects to Spotify authorize with a sealed state cookie", async () => {
		const { response, location, stateCookie } = await startLogin("/playlists/abc");
		expect(response.status).toBe(302);
		expect(location.origin + location.pathname).toBe("https://accounts.spotify.com/authorize");
		expect(location.searchParams.get("client_id")).toBe("client-id");
		expect(location.searchParams.get("response_type")).toBe("code");
		expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
		expect(location.searchParams.get("scope")).toBe(
			"playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private",
		);
		expect(location.searchParams.get("state")).toHaveLength(44);
		expect(stateCookie.attributes).toContain("HttpOnly");
		expect(stateCookie.attributes).toContain("Secure");
		expect(stateCookie.attributes).toContain("SameSite=Lax");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("GET /auth/callback", () => {
	test("exchanges the code, stores the session and returns to the original page", async () => {
		const requests = mockFetch(() =>
			jsonResponse({ access_token: "at", token_type: "Bearer", scope: "", expires_in: 3600, refresh_token: "rt" }),
		);
		const { location, stateCookie } = await startLogin("/playlists/abc?x=1");

		const response = await callback({ code: "c0de", state: location.searchParams.get("state")! }, stateCookie.value);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/playlists/abc?x=1");

		expect(requests).toHaveLength(1);
		const tokenRequest = requests[0]!;
		expect(tokenRequest.url).toBe("https://accounts.spotify.com/api/token");
		expect(tokenRequest.headers.get("Authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
		const body = new URLSearchParams(await tokenRequest.text());
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("c0de");
		expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);

		const cookies = setCookies(response);
		expect(cookies.get("__Host-ssc_state")!.attributes).toContain("Max-Age=0");
		const session = await unseal<Session>(
			TEST_ENV.COOKIE_ENCRYPTION_KEY,
			"session",
			cookies.get("__Host-ssc_session")!.value,
			60,
		);
		expect(session).toMatchObject({ accessToken: "at", refreshToken: "rt" });
		expect(session!.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
	});

	test("rejects a mismatched state without calling Spotify", async () => {
		const requests = mockFetch(() => jsonResponse({}));
		const { stateCookie } = await startLogin();
		const response = await callback({ code: "c0de", state: "forged" }, stateCookie.value);
		expect(response.headers.get("Location")).toBe("/?auth_error=state_mismatch");
		expect(requests).toHaveLength(0);
	});

	test("rejects a callback without the state cookie", async () => {
		const { location } = await startLogin();
		const response = await callback({ code: "c0de", state: location.searchParams.get("state")! });
		expect(response.headers.get("Location")).toBe("/?auth_error=state_mismatch");
	});

	test("reports a denied authorization", async () => {
		const { location, stateCookie } = await startLogin();
		const response = await callback(
			{ error: "access_denied", state: location.searchParams.get("state")! },
			stateCookie.value,
		);
		expect(response.headers.get("Location")).toBe("/?auth_error=access_denied");
	});

	test("reports a failed token exchange", async () => {
		mockFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));
		const { location, stateCookie } = await startLogin();
		const response = await callback({ code: "c0de", state: location.searchParams.get("state")! }, stateCookie.value);
		expect(response.headers.get("Location")).toBe("/?auth_error=token_exchange_failed");
		expect(setCookies(response).has("__Host-ssc_session")).toBe(false);
	});
});

describe("POST /auth/logout", () => {
	test("clears the session for same-origin requests", async () => {
		const response = await app.request(
			`${ORIGIN}/auth/logout`,
			{ method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
			TEST_ENV,
		);
		expect(response.status).toBe(303);
		expect(setCookies(response).get("__Host-ssc_session")!.attributes).toContain("Max-Age=0");
	});

	test("rejects cross-site requests", async () => {
		const response = await app.request(
			`${ORIGIN}/auth/logout`,
			{ method: "POST", headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" } },
			TEST_ENV,
		);
		expect(response.status).toBe(403);
		expect(setCookies(response).has("__Host-ssc_session")).toBe(false);
	});
});

describe("sanitizeReturnTo", () => {
	test.each([
		[undefined, "/"],
		["", "/"],
		["/playlists/abc?x=1#frag", "/playlists/abc?x=1"],
		["https://app.test/playlists/abc", "/playlists/abc"],
		["//evil.example/x", "/"],
		["/\\evil.example/x", "/"],
		["https://evil.example/", "/"],
		["https://app.test//evil.example/x", "/"],
		["javascript:alert(1)", "/"],
		["http://app.test/", "/"],
	])("%p -> %p", (input, expected) => {
		expect(sanitizeReturnTo(input, ORIGIN)).toBe(expected);
	});
});
