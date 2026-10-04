import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { encodeBase64Url } from "hono/utils/encode";
import { timingSafeEqual } from "hono/utils/buffer";
import { seal, unseal } from "./cookieCrypto.ts";
import type { AppEnv } from "./env.ts";
import { sameOrigin } from "./sameOrigin.ts";
import { clearSession, writeSession } from "./session.ts";
import { buildAuthorizeUrl, exchangeCode, SpotifyTokenError } from "./spotifyAccounts.ts";

type OAuthState = {
	state: string;
	returnTo: string;
};

const STATE_COOKIE = "ssc_state";
const STATE_MAX_AGE = 10 * 60;

export const auth = new Hono<AppEnv>();

auth.use(sameOrigin);

auth.get("/login", async (c) => {
	const origin = new URL(c.req.url).origin;
	const pending: OAuthState = {
		state: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer),
		returnTo: sanitizeReturnTo(c.req.query("return_to"), origin),
	};
	setCookie(c, STATE_COOKIE, await seal(c.env.COOKIE_ENCRYPTION_KEY, "oauth_state", pending), {
		prefix: "host",
		path: "/",
		secure: true,
		httpOnly: true,
		sameSite: "Lax",
		maxAge: STATE_MAX_AGE,
	});
	return c.redirect(buildAuthorizeUrl(c.env.SPOTIFY_CLIENT_ID, `${origin}/auth/callback`, pending.state));
});

auth.get("/callback", async (c) => {
	const origin = new URL(c.req.url).origin;
	const stateCookie = getCookie(c, STATE_COOKIE, "host");
	deleteCookie(c, STATE_COOKIE, { prefix: "host", path: "/", secure: true });

	const pending = stateCookie
		? await unseal<OAuthState>(c.env.COOKIE_ENCRYPTION_KEY, "oauth_state", stateCookie, STATE_MAX_AGE)
		: undefined;
	const state = c.req.query("state");
	if (!pending || !state || !(await timingSafeEqual(pending.state, state))) {
		return c.redirect("/?auth_error=state_mismatch");
	}

	const code = c.req.query("code");
	if (!code) return c.redirect(`/?auth_error=${encodeURIComponent(c.req.query("error") ?? "missing_code")}`);

	try {
		const session = await exchangeCode(
			{ clientId: c.env.SPOTIFY_CLIENT_ID, clientSecret: c.env.SPOTIFY_CLIENT_SECRET },
			code,
			`${origin}/auth/callback`,
		);
		await writeSession(c, session);
	} catch (error) {
		if (error instanceof SpotifyTokenError) return c.redirect("/?auth_error=token_exchange_failed");
		throw error;
	}
	return c.redirect(pending.returnTo);
});

auth.post("/logout", (c) => {
	clearSession(c);
	return c.redirect("/", 303);
});

export function sanitizeReturnTo(value: string | undefined, origin: string): string {
	if (!value) return "/";
	let url: URL;
	try {
		url = new URL(value, origin);
	} catch {
		return "/";
	}
	// A leading "//" would be followed as a protocol-relative redirect.
	if (url.origin !== origin || url.pathname.startsWith("//")) return "/";
	return url.pathname + url.search;
}
