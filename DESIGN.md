# Technical Design

This is the implementation reference for future work on this repository. [README.md](README.md) covers the product requirements and setup. This document and the files under [docs/](docs/) cover how the app is built, why it is built that way, and the external-API facts the code depends on. The facts were verified in October 2026.

## Architecture

```
Browser (React SPA)
  │  same origin
  ▼
Cloudflare Worker (Hono) ── static assets (Vite client build, SPA fallback)
  ├─ /auth/*  ── accounts.spotify.com   (OAuth code flow)
  ├─ /api/*   ── api.spotify.com/v1     (Web API, user's token)
  └─ /mora/*  ── mora.jp/search/getResult (keyword search, server-side only)
```

A single Worker serves both the SPA assets and the dynamic routes. There is no database and no server-side state:

- Spotify tokens live in an encrypted cookie.
- "Purchased" marks live in the browser's localStorage.
- The last shopping record lives in the playlist's description on Spotify.

## Repository layout

| Path | Role |
|---|---|
| `cloudflare.config.ts` | `cf` CLI config: worker entrypoint, secrets, assets routing, observability |
| `vite.config.ts` | `react()` + `cloudflare()` plugins; no server settings (trustless injects them) |
| `index.html`, `src/client/` | React SPA |
| `src/worker/` | Hono app (`index.ts` is the entrypoint, `export default app`) |
| `src/worker/mora/` | mora search client, title/artist normalization, matcher, redirector route |
| `src/worker/lastShopping.ts` | Reads and writes the last shopping record in a playlist description |
| `src/shared/types.ts` | API contract between worker and client: request/response and error codes |
| `public/_headers` | CSP and security headers for static assets (production only) |
| `test/` | `bun test` suites, helpers, and recorded mora fixtures |
| `tsconfig.{base,worker,client,test}.json` | Split type-check programs (see [toolchain](docs/toolchain.md#type-check-programs)); `tsconfig.json` is a solution-style root |

## Documents

Read the ones that cover the area you are working on.

| Document | Covers | Read before |
|---|---|---|
| [docs/toolchain.md](docs/toolchain.md) | `cf` CLI vs Wrangler, the three type-check programs, trustless local development | touching config, bindings, route prefixes, build or dev setup; fixing type errors |
| [docs/worker.md](docs/worker.md) | Worker routes, middleware, sealed cookies, session and token refresh, CSRF, the last shopping record | changing `/auth` or `/api` routes, cookies, error handling or the playlist description format |
| [docs/spotify.md](docs/spotify.md) | Spotify Web API facts: Development Mode limits, endpoints, tokens, normalization | calling Spotify or changing how playlist items are fetched or removed |
| [docs/mora.md](docs/mora.md) | mora search API facts, the `/mora/redirect` request and the matching algorithm | changing mora search, matching thresholds or the redirector |
| [docs/client.md](docs/client.md) | SPA routing and data fetching, grouping, purchased marks, removal, styling, CSP | changing anything under `src/client/` or `public/_headers` |
| [docs/testing.md](docs/testing.md) | Test layout, helpers, recorded mora fixtures, manual UI checks | writing tests or re-recording fixtures |
| [docs/limitations.md](docs/limitations.md) | Unverified behaviour, known limitations, possible next steps | planning new work or debugging against real Spotify/mora |

## Conventions

- Commits follow sorah-guides commit style: a short lowercase-imperative or `component:` subject, and a body explaining why. Each commit is self-contained and passes all checks.
- Before each commit, run `bun test && bun run typecheck && bun run build`.
- TypeScript:
  - Prefer `type` over `interface`.
  - Use discriminated unions such as `MoraResolution` and `ParsedPlaylist`.
  - Use explicit `as T` casts for JSON instead of `any`.
  - Use custom `Error` subclasses for errors other code must recognise.
  - Indent with tabs.
- Comments explain only why something is non-obvious or record an external constraint; no change narration.
- Pages use default exports; everything else uses named exports.
