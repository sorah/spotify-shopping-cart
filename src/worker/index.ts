import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import type { ApiError } from "../shared/types.ts";
import { api, ForbiddenError } from "./api.ts";
import { auth } from "./auth.ts";
import type { AppEnv } from "./env.ts";
import { mora } from "./mora/routes.ts";
import { SpotifyApiError } from "./spotify.ts";
import { SpotifyTokenError } from "./spotifyAccounts.ts";

const noStore = createMiddleware(async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});

const app = new Hono<AppEnv>();

app.use(secureHeaders());
app.use("/api/*", noStore);
app.use("/auth/*", noStore);
app.use("/mora/*", noStore);

app.route("/auth", auth);
app.route("/api", api);
app.route("/mora", mora);

app.notFound((c) => c.json<ApiError>({ code: "not_found" }, 404));

app.onError((error, c) => {
	if (error instanceof ForbiddenError) return c.json<ApiError>({ code: error.code }, 403);
	if (error instanceof SpotifyTokenError && error.isInvalidGrant) {
		return c.json<ApiError>({ code: "reauth_required" }, 401);
	}
	if (error instanceof SpotifyApiError) {
		switch (error.status) {
			case 401:
				return c.json<ApiError>({ code: "reauth_required" }, 401);
			case 404:
				return c.json<ApiError>({ code: "not_found" }, 404);
			case 429:
				if (error.retryAfter) c.header("Retry-After", error.retryAfter);
				return c.json<ApiError>({ code: "rate_limited" }, 429);
			default:
				console.error(error);
				return c.json<ApiError>({ code: "spotify_error", message: error.message }, 502);
		}
	}
	console.error(error);
	return c.json({ message: "Internal Server Error" }, 500);
});

export default app;
