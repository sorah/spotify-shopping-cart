import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiError, LastShopping, PutLastShoppingResponse, RemovePlaylistItemsResponse } from "../shared/types.ts";
import type { AppEnv } from "./env.ts";
import { formatDescription, isValidTimeZone } from "./lastShopping.ts";
import { sameOrigin } from "./sameOrigin.ts";
import { requireSession } from "./session.ts";
import {
	getMe,
	getPlaylist,
	getPlaylistDescription,
	getPlaylistItems,
	removePlaylistItems,
	SpotifyApiError,
	updatePlaylistDescription,
} from "./spotify.ts";

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

api.put("/playlists/:id/last-shopping", requireJson, async (c) => {
	const body = (await c.req.json().catch(() => undefined)) as
		| { songCount?: unknown; timeZone?: unknown }
		| undefined;
	const songCount = body?.songCount;
	const timeZone = body?.timeZone;
	if (typeof songCount !== "number" || !Number.isSafeInteger(songCount) || songCount < 1) {
		return c.json<ApiError>({ code: "bad_request", message: "songCount must be a positive integer" }, 400);
	}
	if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) {
		return c.json<ApiError>({ code: "bad_request", message: "timeZone must be an IANA time zone" }, 400);
	}

	const id = c.req.param("id");
	const lastShopping: LastShopping = { at: new Date().toISOString(), songCount };
	const current = await getPlaylistDescription(c, id).catch(rethrowForbiddenAs("playlist_forbidden"));
	await updatePlaylistDescription(c, id, formatDescription(current, lastShopping, timeZone)).catch(
		rethrowForbiddenAs("playlist_forbidden"),
	);
	return c.json<PutLastShoppingResponse>(lastShopping);
});
