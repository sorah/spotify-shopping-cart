import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sameOrigin } from "../../src/worker/sameOrigin.ts";
import { ORIGIN } from "../helpers/env.ts";

const app = new Hono().use(sameOrigin).all("/", (c) => c.text("ok"));

function request(method: string, headers: Record<string, string>) {
	return app.request(`${ORIGIN}/`, { method, headers });
}

describe("sameOrigin", () => {
	test.each([
		["GET", {}, 200],
		["POST", { "Sec-Fetch-Site": "same-origin" }, 200],
		["POST", { "Sec-Fetch-Site": "same-site" }, 403],
		["POST", { "Sec-Fetch-Site": "cross-site", Origin: ORIGIN }, 403],
		["POST", { Origin: ORIGIN }, 200],
		["POST", { Origin: "https://evil.test" }, 403],
		["POST", {}, 403],
		["DELETE", { "Sec-Fetch-Site": "none" }, 403],
	] as const)("%s %p -> %d", async (method, headers, status) => {
		expect((await request(method, headers)).status).toBe(status);
	});
});
