import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { ApiError } from "../shared/types.ts";
import { seal, unseal } from "./cookieCrypto.ts";
import type { AppEnv } from "./env.ts";
import { refreshAccessToken, SpotifyTokenError, type TokenSet } from "./spotifyAccounts.ts";

export type Session = TokenSet;

const SESSION_COOKIE = "ssc_session";
export const SESSION_MAX_AGE = 180 * 24 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function readSession(c: Context<AppEnv>): Promise<Session | undefined> {
	const value = getCookie(c, SESSION_COOKIE, "host");
	if (!value) return undefined;
	return unseal<Session>(c.env.COOKIE_ENCRYPTION_KEY, "session", value, SESSION_MAX_AGE);
}

export async function writeSession(c: Context<AppEnv>, session: Session): Promise<void> {
	const value = await seal(c.env.COOKIE_ENCRYPTION_KEY, "session", session);
	setCookie(c, SESSION_COOKIE, value, {
		prefix: "host",
		path: "/",
		secure: true,
		httpOnly: true,
		sameSite: "Lax",
		maxAge: SESSION_MAX_AGE,
	});
}

export function clearSession(c: Context<AppEnv>): void {
	deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
}

export async function refreshSession(c: Context<AppEnv>): Promise<Session> {
	const session = await refreshAccessToken(
		{ clientId: c.env.SPOTIFY_CLIENT_ID, clientSecret: c.env.SPOTIFY_CLIENT_SECRET },
		c.var.session.refreshToken,
	);
	await writeSession(c, session);
	c.set("session", session);
	return session;
}

// On invalid_grant the cookie is kept: a concurrent request may have already rotated it.
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
	const session = await readSession(c);
	if (!session) return c.json<ApiError>({ code: "unauthenticated" }, 401);
	c.set("session", session);

	if (session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
		try {
			await refreshSession(c);
		} catch (error) {
			if (error instanceof SpotifyTokenError && error.isInvalidGrant) {
				return c.json<ApiError>({ code: "reauth_required" }, 401);
			}
			throw error;
		}
	}
	await next();
});
