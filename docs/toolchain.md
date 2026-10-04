# Toolchain

## `cf` CLI instead of Wrangler

The project uses the `cf` CLI (`cf` 1.0 beta) with `cloudflare.config.ts` (`import { bindings, defineConfig } from "cf/config"`). Do not add a `wrangler.toml`/`wrangler.jsonc`. Points that differ from Wrangler:

- **Static assets.** There is no assets directory option. Assets are whatever the Vite `client` environment builds (the root `index.html` plus `public/`). Build output goes to `.cloudflare/output/v0/workers/default/{bundle,assets}`.
- **`runWorkerFirst`.** With a compatibility date of 2025-04-01 or later, a navigation request that doesn't match `assets.runWorkerFirst` is answered with the SPA `index.html` without ever reaching the Worker. Every Worker route prefix must therefore be listed there; today that is `/api/*`, `/auth/*` and `/mora/*`. Add new prefixes to it.
- **Secrets.**
  - Declared with `bindings.secret()`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`.
  - Locally they are read from `.dev.vars`; `.dev.vars.example` lists them.
  - The first deploy needs `cf deploy --secrets-file <file>`. Later deploys keep existing values unless a file is passed again.
- **Bun runtime.** `cloudflare.config.ts` cannot be loaded under the Bun runtime. Never run cf through `bun --bun`, and never import the config from tests.
- **Types.** `cf workers types` (part of `bun run typecheck`) regenerates `.cloudflare/types/index.d.ts`. It is gitignored.

## Type-check programs

The generated Workers types declare globals (`fetch`, `caches`, `navigator`, …) that clash with both `lib.dom` and `@types/bun`, so the code is checked as three programs:

| Program | Includes | Libs/types |
|---|---|---|
| `tsconfig.worker.json` | `src/worker`, `src/shared`, `cloudflare.config.ts`, `.cloudflare/types` | es2024, no DOM |
| `tsconfig.client.json` | `src/client`, `src/shared` | es2024 + DOM, `vite/client`, `jsx: react-jsx` |
| `tsconfig.test.json` | `test` (plus whatever it imports) | es2024 + DOM, `bun` |

Consequences:

- **No generated `Env` in worker code.** The test program includes worker modules but not `.cloudflare/types`, so worker code must not use the generated global `Env`. Use `Bindings`/`AppEnv` from `src/worker/env.ts` instead. `src/worker/env-check.ts` is compiled only in the worker program; it fails the build if `Env` stops satisfying `Bindings`, so update both when adding a binding.
- **No Workers-only APIs.** Worker code must not use `cloudflare:workers` or other Workers-only APIs; read `c.env` instead. This lets tests drive the app with `app.request(url, init, env)`.
- **`Response#json<T>()`** is generic only in the Workers types. Write `(await res.json()) as T`.
- **Shared contract.** The client must not import worker modules; that would pull Workers globals into the DOM program. This is why the app uses `src/shared/types.ts` and not Hono RPC (`hono/client`).

## Local development: trustless

`bun run dev` runs `trustless run vite dev`, which serves the app at `https://spotify-shopping-cart.<trustless domain>:1443` (see [sorah/trustless](https://github.com/sorah/trustless)).

- **Vite flags.** trustless detects `vite` but not `cf dev`. It injects `--port/--strictPort/--host 127.0.0.1` and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. Do not hardcode `server.host`/`server.port`.
- **Request origin.** trustless forwards the original `Host` and `X-Forwarded-Proto: https`, and `@cloudflare/vite-plugin` builds the Worker's request URL from those headers. As a result, `new URL(c.req.url).origin` is the public HTTPS origin in development and production alike. OAuth redirect URIs and `__Host-` cookies rely on this; no forwarded-header handling exists in app code.
- **Plaintext fallback.** `http://<name>.localhost:1355` works for the UI. Spotify does not accept it as a redirect URI, so login needs the HTTPS route.
- **`.dev.vars`.** Missing `.dev.vars` values only produce a warning at startup; the bindings are then `undefined` at runtime.
