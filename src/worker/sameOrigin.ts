import { createMiddleware } from "hono/factory";
import type { ApiError } from "../shared/types.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// hono/csrf only inspects form-like content types, so JSON requests need their own check.
export const sameOrigin = createMiddleware(async (c, next) => {
	if (!SAFE_METHODS.has(c.req.method)) {
		const site = c.req.header("Sec-Fetch-Site");
		const isSameOrigin =
			site !== undefined ? site === "same-origin" : c.req.header("Origin") === new URL(c.req.url).origin;
		if (!isSameOrigin) return c.json<ApiError>({ code: "cross_origin_request" }, 403);
	}
	await next();
});
