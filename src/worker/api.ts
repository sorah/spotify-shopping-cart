import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiError, RemovePlaylistItemsResponse } from "../shared/types.ts";
import type { AppEnv } from "./env.ts";
import { sameOrigin } from "./sameOrigin.ts";
import { requireSession } from "./session.ts";
import { getMe, getPlaylist, getPlaylistItems, removePlaylistItems, SpotifyApiError } from "./spotify.ts";

const PLAYLIST_ID_RE = /^[A-Za-z0-9]{22}$/;
const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const MAX_REMOVE_URIS = 500;

const requireJson = createMiddleware(async (c, next) => {
	if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
		return c.json<ApiError>({ code: "unsupported_media_type" }, 415);
	}
	await next();
});

const validatePlaylistId = createMiddleware(async (c, next) => {
	if (!PLAYLIST_ID_RE.test(c.req.param("id") ?? "")) {
		return c.json<ApiError>({ code: "bad_request", message: "invalid playlist id" }, 400);
	}
	await next();
});

export class ForbiddenError extends Error {
	constructor(readonly code: ApiError["code"]) {
		super(code);
	}
}

function rethrowForbiddenAs(code: ApiError["code"]) {
	return (error: unknown): never => {
		if (error instanceof SpotifyApiError && error.status === 403) throw new ForbiddenError(code);
		throw error;
	};
}

export const api = new Hono<AppEnv>();

api.use(sameOrigin, requireSession);
api.use("/playlists/:id/*", validatePlaylistId);
api.use("/playlists/:id", validatePlaylistId);

// A 403 on /me means the user is not on the Development Mode allowlist.
api.get("/me", async (c) => c.json(await getMe(c).catch(rethrowForbiddenAs("not_allowlisted"))));

api.get("/playlists/:id", async (c) => c.json(await getPlaylist(c, c.req.param("id"))));

// Development Mode apps may only read playlists the user owns or collaborates on.
api.get("/playlists/:id/items", async (c) => {
	const offset = Number(c.req.query("offset") ?? "0");
	if (!Number.isSafeInteger(offset) || offset < 0) {
		return c.json<ApiError>({ code: "bad_request", message: "invalid offset" }, 400);
	}
	return c.json(
		await getPlaylistItems(c, c.req.param("id"), offset).catch(rethrowForbiddenAs("playlist_forbidden")),
	);
});

api.post("/playlists/:id/remove", requireJson, async (c) => {
	const body = (await c.req.json().catch(() => undefined)) as { uris?: unknown } | undefined;
	const uris = body?.uris;
	if (
		!Array.isArray(uris) ||
		uris.length === 0 ||
		uris.length > MAX_REMOVE_URIS ||
		!uris.every((uri) => typeof uri === "string" && TRACK_URI_RE.test(uri))
	) {
		return c.json<ApiError>(
			{ code: "bad_request", message: `uris must be 1-${MAX_REMOVE_URIS} spotify:track URIs` },
			400,
		);
	}
	const unique = [...new Set(uris as string[])];
	const snapshotId = await removePlaylistItems(c, c.req.param("id"), unique).catch(
		rethrowForbiddenAs("playlist_forbidden"),
	);
	return c.json<RemovePlaylistItemsResponse>({ snapshotId, removed: unique.length });
});
