import { Hono } from "hono";
import type { AppEnv } from "./env.ts";

const app = new Hono<AppEnv>();

app.notFound((c) => c.json({ code: "not_found" }, 404));

export default app;
