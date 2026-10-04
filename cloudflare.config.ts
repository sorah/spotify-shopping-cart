import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "spotify-shopping-cart",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			WORLD: bindings.text("World"),
		},
	},
});
