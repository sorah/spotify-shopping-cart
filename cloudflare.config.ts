import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "spotify-shopping-cart",
		compatibilityDate: "2026-10-01",
		entrypoint,
		observability: { enabled: true },
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/auth/*", "/mora/*"],
		},
		env: {
			SPOTIFY_CLIENT_ID: bindings.secret(),
			SPOTIFY_CLIENT_SECRET: bindings.secret(),
			COOKIE_ENCRYPTION_KEY: bindings.secret(),
		},
	},
});
