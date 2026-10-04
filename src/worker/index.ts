import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import type { ApiError } from "../shared/types.ts";
import { auth } from "./auth.ts";
import type { AppEnv } from "./env.ts";

const noStore = createMiddleware(async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});

const app = new Hono<AppEnv>();

app.use(secureHeaders());
app.use("/api/*", noStore);
app.use("/auth/*", noStore);

app.route("/auth", auth);

app.notFound((c) => c.json<ApiError>({ code: "not_found" }, 404));

export default app;
