import type { Bindings } from "../../src/worker/env.ts";

export const ORIGIN = "https://app.test";

export const TEST_ENV: Bindings = {
	SPOTIFY_CLIENT_ID: "client-id",
	SPOTIFY_CLIENT_SECRET: "client-secret",
	COOKIE_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i))),
};
