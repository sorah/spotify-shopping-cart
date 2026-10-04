import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { unseal } from "../../src/worker/cookieCrypto.ts";
import type { AppEnv } from "../../src/worker/env.ts";
import { requireSession, type Session } from "../../src/worker/session.ts";
import { cookieHeader, sessionCookie, setCookies } from "../helpers/cookies.ts";
import { ORIGIN, TEST_ENV } from "../helpers/env.ts";
import { jsonResponse, mockFetch } from "../helpers/fetchMock.ts";

afterEach(() => mock.restore());

const app = new Hono<AppEnv>().use(requireSession).get("/token", (c) => c.text(c.var.session.accessToken));

function request(cookie?: string) {
	return app.request(`${ORIGIN}/token`, { headers: cookie ? { Cookie: cookie } : {} }, TEST_ENV);
}

const FRESH: Session = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 };
const EXPIRING: Session = { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 60_000 };

describe("requireSession", () => {
	test("rejects requests without a session", async () => {
		const response = await request();
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ code: "unauthenticated" });
	});

	test("rejects an undecryptable session", async () => {
		const response = await request(cookieHeader({ "__Host-ssc_session": "v1.AAAA.AAAA" }));
		expect(response.status).toBe(401);
	});

	test("passes a fresh session through without refreshing", async () => {
		const requests = mockFetch(() => jsonResponse({}));
		const response = await request(await sessionCookie(FRESH));
		expect(await response.text()).toBe("at");
		expect(requests).toHaveLength(0);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	test("refreshes an expiring session and stores the rotated refresh token", async () => {
		const requests = mockFetch(() =>
			jsonResponse({ access_token: "new", token_type: "Bearer", scope: "", expires_in: 3600, refresh_token: "rt2" }),
		);
		const response = await request(await sessionCookie(EXPIRING));
		expect(await response.text()).toBe("new");

		const body = new URLSearchParams(await requests[0]!.text());
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("rt");

		const stored = await unseal<Session>(
			TEST_ENV.COOKIE_ENCRYPTION_KEY,
			"session",
			setCookies(response).get("__Host-ssc_session")!.value,
			60,
		);
		expect(stored).toMatchObject({ accessToken: "new", refreshToken: "rt2" });
	});

	test("keeps the refresh token when Spotify does not rotate it", async () => {
		mockFetch(() => jsonResponse({ access_token: "new", token_type: "Bearer", scope: "", expires_in: 3600 }));
		const response = await request(await sessionCookie(EXPIRING));
		const stored = await unseal<Session>(
			TEST_ENV.COOKIE_ENCRYPTION_KEY,
			"session",
			setCookies(response).get("__Host-ssc_session")!.value,
			60,
		);
		expect(stored).toMatchObject({ accessToken: "new", refreshToken: "rt" });
	});

	test("asks for re-authentication on invalid_grant without clearing the cookie", async () => {
		mockFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));
		const response = await request(await sessionCookie(EXPIRING));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ code: "reauth_required" });
		expect(response.headers.getSetCookie()).toEqual([]);
	});
});
