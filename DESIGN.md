# Technical Design

This is the implementation reference for future work on this repository. [README.md](README.md) covers the product requirements and setup. This document covers how the app is built, why it is built that way, and the external-API facts the code depends on. The facts were verified in October 2026.

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

## Repository layout

| Path | Role |
|---|---|
| `cloudflare.config.ts` | `cf` CLI config: worker entrypoint, secrets, assets routing, observability |
| `vite.config.ts` | `react()` + `cloudflare()` plugins; no server settings (trustless injects them) |
| `index.html`, `src/client/` | React SPA |
| `src/worker/` | Hono app (`index.ts` is the entrypoint, `export default app`) |
| `src/worker/mora/` | mora search client, title/artist normalization, matcher, redirector route |
| `src/shared/types.ts` | API contract between worker and client: request/response and error codes |
| `public/_headers` | CSP and security headers for static assets (production only) |
| `test/` | `bun test` suites, helpers, and recorded mora fixtures |
| `tsconfig.{base,worker,client,test}.json` | Split type-check programs (see below); `tsconfig.json` is a solution-style root |

## Toolchain

### `cf` CLI instead of Wrangler

The project uses the `cf` CLI (`cf` 1.0 beta) with `cloudflare.config.ts` (`import { bindings, defineConfig } from "cf/config"`). Do not add a `wrangler.toml`/`wrangler.jsonc`. Points that differ from Wrangler:

- **Static assets.** There is no assets directory option. Assets are whatever the Vite `client` environment builds (the root `index.html` plus `public/`). Build output goes to `.cloudflare/output/v0/workers/default/{bundle,assets}`.
- **`runWorkerFirst`.** With a compatibility date of 2025-04-01 or later, a navigation request that doesn't match `assets.runWorkerFirst` is answered with the SPA `index.html` without ever reaching the Worker. Every Worker route prefix must therefore be listed there; today that is `/api/*`, `/auth/*` and `/mora/*`. Add new prefixes to it.
- **Secrets.**
  - Declared with `bindings.secret()`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`.
  - Locally they are read from `.dev.vars`; `.dev.vars.example` lists them.
  - The first deploy needs `cf deploy --secrets-file <file>`. Later deploys keep existing values unless a file is passed again.
- **Bun runtime.** `cloudflare.config.ts` cannot be loaded under the Bun runtime. Never run cf through `bun --bun`, and never import the config from tests.
- **Types.** `cf workers types` (part of `bun run typecheck`) regenerates `.cloudflare/types/index.d.ts`. It is gitignored.

### Type-check programs

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

### Local development: trustless

`bun run dev` runs `trustless run vite dev`, which serves the app at `https://spotify-shopping-cart.<trustless domain>:1443` (see [sorah/trustless](https://github.com/sorah/trustless)).

- **Vite flags.** trustless detects `vite` but not `cf dev`. It injects `--port/--strictPort/--host 127.0.0.1` and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. Do not hardcode `server.host`/`server.port`.
- **Request origin.** trustless forwards the original `Host` and `X-Forwarded-Proto: https`, and `@cloudflare/vite-plugin` builds the Worker's request URL from those headers. As a result, `new URL(c.req.url).origin` is the public HTTPS origin in development and production alike. OAuth redirect URIs and `__Host-` cookies rely on this; no forwarded-header handling exists in app code.
- **Plaintext fallback.** `http://<name>.localhost:1355` works for the UI. Spotify does not accept it as a redirect URI, so login needs the HTTPS route.
- **`.dev.vars`.** Missing `.dev.vars` values only produce a warning at startup; the bindings are then `undefined` at runtime.

## Worker

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/login?return_to=` | – | Start OAuth: sets a sealed state cookie and redirects (302) to Spotify authorize |
| `GET /auth/callback` | state cookie | Exchange the code and set the session cookie; redirect (302) to `return_to`, or to `/?auth_error=<code>` on failure |
| `POST /auth/logout` | same-origin | Clear the session; 303 to `/` |
| `GET /api/me` | session | `{id, displayName}` |
| `GET /api/playlists/:id` | session | Playlist metadata |
| `GET /api/playlists/:id/items?offset=` | session | One normalized page of 50 items, plus `nextOffset` |
| `POST /api/playlists/:id/remove` | session, same-origin, JSON | `{uris}`, at most 500 per request; removes them from the playlist |
| `GET /mora/redirect?...` | session cookie | mora redirector (see below) |

Middleware applied to these routes:

- `secureHeaders()` on all Worker responses.
- `Cache-Control: no-store` on `/api`, `/auth` and `/mora`.
- `onError` in `index.ts` maps `SpotifyApiError`/`SpotifyTokenError`/`ForbiddenError` to `ApiError` JSON. Error codes are defined in `src/shared/types.ts`, and the client turns each one into a user-facing message in `ApiErrorNotice.tsx`.

### Cookies and session (`cookieCrypto.ts`, `session.ts`, `auth.ts`)

**Sealing**
- Values are encrypted with AES-256-GCM. The key is `COOKIE_ENCRYPTION_KEY`, which must base64-decode to exactly 32 bytes; the imported key is cached per isolate.
- Wire format: `v1.<iv b64url>.<ciphertext b64url>`.
- The plaintext is `{iat, data}`, so maximum age is enforced on the server and doesn't depend on the cookie's `Max-Age`.
- The AAD is a fixed purpose string, `"session"` or `"oauth_state"`. A state cookie can therefore never be replayed as a session.

**Cookies**
- `__Host-ssc_session`: Secure, HttpOnly, `SameSite=Lax`, Path=/, maximum age 180 days. Payload `{accessToken, refreshToken, expiresAt}`.
- `__Host-ssc_state`: same attributes, maximum age 10 minutes. Payload `{state, returnTo}`.
- `SameSite=Strict` would break the callback, which arrives as a cross-site navigation from accounts.spotify.com.

**`return_to`**
- Resolved against the request origin. It must stay same-origin and must not start with `//`.
- Only `pathname + search` is kept; anything else becomes `/`.

**Token refresh**
- `requireSession` refreshes the token when less than 5 minutes of validity remain.
- If the refresh response has no `refresh_token`, the old one is kept; Spotify doesn't always rotate it.
- On `invalid_grant` it returns 401 `reauth_required` without clearing the cookie. A concurrent request may already have rotated the refresh token and written a newer cookie, and clearing would overwrite it.
- To make that race rare, the client loads `/api/me` before firing any other API request.
- `spotifyFetch` retries once after a forced refresh when Spotify answers 401.

**CSRF (`sameOrigin.ts`)**
- Unsafe methods require `Sec-Fetch-Site: same-origin`. When that header is absent, `Origin` must match the request origin.
- `/api` POSTs also require `Content-Type: application/json` (415 otherwise).
- `hono/csrf` isn't used because it only inspects form-like content types.

### Spotify Web API (`spotify.ts`, `spotifyAccounts.ts`)

The code targets the API as it stands after the February 2026 changes for Development Mode apps.

**Development Mode limits**
- An app can read and edit only playlists the user owns or collaborates on; other playlists return 403, which maps to `playlist_forbidden`.
- At most 5 allowlisted users. A user missing from the allowlist gets 403 on `/me`, which maps to `not_allowlisted`.
- The app owner needs Premium.
- Extended Quota Mode is effectively unavailable to individuals.

**Endpoints**
- **Items.** `GET /playlists/{id}/items`; the old `/tracks` path is gone. Each entry's track is under `item`, with the deprecated `track` key as a fallback. The `fields` filter requests both so that whichever one is present survives filtering.
- **Removal.** `DELETE /playlists/{id}/items` with `{items: [{uri}]}`.
  - At most 100 URIs per call. The worker chunks and sends no `snapshot_id`.
  - Removing by URI deletes every occurrence of the track.
  - Local files can't be removed by URI, so the API accepts only `spotify:track:<22 chars>`, and the UI disables actions for local files.
- **No `market` parameter, ever.** Track relinking would return URIs that can't be removed from the playlist.
- **`Accept-Language: ja`** is sent so Japanese names come back in Japanese, which is what mora indexes. Whether Spotify honours it hasn't been verified.
- **Tokens.**
  - Scopes: `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private`.
  - Refresh tokens expire 6 months after authorization, after which `invalid_grant` leads to re-login.
  - Redirect URIs must be HTTPS, or a loopback IP (never `localhost`).

**Normalization (`normalizeItemsPage`)**
- Episodes and null (unavailable) items are dropped.
- Local files are kept with `album.id = null`.
- `position` is the absolute playlist index.
- The image is the smallest one at least 128px wide.

**Pagination**
- The client loops `nextOffset` itself. Each page is one Worker request with one subrequest, which avoids the Worker subrequest limit on large playlists.

### mora redirector (`src/worker/mora/`)

#### mora facts (verified live)

**Search endpoint**
- `GET https://mora.jp/search/getResult?keyWord=<q>&searchKind=02` returns packages (albums/singles); `searchKind=03` returns tracks.
- Each call returns at most 12 packages or 10 tracks, with no paging.
- The keyword is AND-matched across artist and title fields.
- The body is JSON even though it is labelled `text/html`.
- A section's `resultCode` of `SM*` means OK; `EM0305200` means no hits.

**Request handling**
- Any request carrying a foreign `Origin` header (including a browser `fetch`) gets a 302 to `/unsupported`. The client therefore fetches server-side with `redirect: "manual"` and a 5-second timeout, and treats any non-200 as a `MoraError`.
- No special headers are needed, and requests from outside Japan are answered.

**Lookup limits**
- There is no ISRC or UPC lookup.
- Qualifiers in the keyword make search return nothing. Examples: `(Deluxe Edition)`, `- Single`.

**Packages and editions**
- AAC, lossless and hi-res editions are separate, unlinked packages. Their IDs vary by label: suffixes such as `_HD`, `_LL`, `_48` or `_L`, a different `labelCode`, or even a different base ID.
- The same `packageId` can exist under different labels, so packages are identified by `labelCode/packageId`.

**`mediaFormatNo`**

| Value | Format |
|---|---|
| 10 | AAC 320k |
| 11 | video (always excluded) |
| 12 | hi-res FLAC |
| 13 | DSD |
| 15 | lossless FLAC 16-bit/44.1 kHz |

**Package URLs**
- Format: `https://mora.jp/package/<labelCode>/<packageId>/`. Adding `?trackMaterialNo=<track materialNo>` highlights a track on the page.
- The track `materialNo` differs between editions.

#### Request

`/mora/redirect?title=&album=&artist=…&albumArtist=…&tracks=<album total_tracks>`

- `artist` and `albumArtist` may repeat. Each value is limited to 200 characters, with at most 10 artists.
- The client builds these URLs in `src/client/lib/mora.ts`.
- A decryptable session cookie is required, so the route can't be used as an anonymous proxy to mora. Without one it redirects to `/auth/login?return_to=…`. Spotify is never called, so a session whose access token has expired still works.

#### Matching (`normalize.ts`, `romanize.ts`, `match.ts`)

**1. Normalization**
- Text is NFKC-normalized and lowercased; anything that isn't a letter or number becomes a space.
- Titles are split into a main part and segments: bracketed text `() [] <> 【】 〔〕 〈〉 《》 ~…~` and ` - …` tails.
- Keys built from that split:

| Key | Built by stripping | Used for |
|---|---|---|
| `fullKey` | format (`FORMAT_RE`) and featuring (`FEAT_RE`) segments | exact title comparison, edition grouping |
| `baseKey` | additionally edition (`EDITION_RE`) and tie-up (`TIEUP_RE`) segments | looser title comparison |
| `keywordTitle` | the same segments as `baseKey`, but keeping the original text | mora search keywords |

- Mix, remix, live and version qualifiers are deliberately kept, because they are different recordings.

**2. Similarity**
- `dice` is the character-bigram Dice coefficient, computed with whitespace removed.
- `titleSim` is 1 if the full keys are equal, 0.92 if the base keys are equal, and otherwise `max(dice(full), 0.9·dice(base))`.
- `artistSim` is the maximum over the Spotify names of:
  - 1 for an exact match (various-artists aliases count as equal);
  - 0.95 for a match against one part of a split mora credit;
  - the Dice score;
  - for ASCII names, `0.9 · dice(looseRomaji(name), looseRomaji(romanizeKana(artistNameKana)))`. This matches romanized Spotify names (e.g. "Kenshi Yonezu" vs ヨネヅケンシ) in either word order.

**3. Retrieval (at most 5 subrequests)**
- Phase 1 runs two queries in parallel:
  - packages: `artist + keywordTitle(album)`
  - tracks: `artist + keywordTitle(title)`
- Either query is retried with the title alone when none of its hits has an artist score of at least 0.5. This covers romanized names, which find nothing or only covers.
- Candidates are the package hits plus the packages referenced by track hits, keyed by `labelCode/packageId`; video packages are skipped.

**4. Album scoring**
- `score = 0.5·A + 0.3·R + 0.12·H + 0.08·C`, where:
  - A = `titleSim(album, packageTitle)`
  - R = the maximum artist score over track artists and album artists
  - H = 1 if a track hit in this package has `titleSim` of at least 0.85
  - C = track-count match: 1 if equal, 0.6 if within 2, 0.5 if unknown, otherwise 0
- A candidate is accepted if `A ≥ 0.75 && R ≥ 0.5 && score ≥ 0.72`, or if `A ≥ 0.9 && H`.
- The winner is the accepted candidate with the highest score; ties go to the earliest `startDate`.

**5. Track fallback** (when no album is accepted)
- Uses the best track hit with title similarity of at least 0.85 and artist score of at least 0.5.
- Hits are ranked by `0.6·title + 0.4·artist`, then by album-title similarity, then by earliest date.
- This covers albums titled differently on mora.

**6. Editions**
- Phase 2 searches packages for `winner.artistName + winner.packageTitle`.
- Editions are all candidates sharing `(fullKey(artistName), fullKey(packageTitle))` with the winner.
- They are ordered AAC → lossless → hi-res → DSD, then by date.
- URLs are rebuilt from a `labelCode` matching `^\d+$` and a `packageId` matching `^[\w.-]+$`; mora's `packagePage` is never trusted.

**7. Response**

| Outcome | Response |
|---|---|
| One edition | 302 to its package page |
| Several editions | HTML chooser (`hono/html`, auto-escaped) |
| No match, or a `MoraError` | 302 to `https://mora.jp/search/top?keyWord=<artist title>` |
| `debug=1` present | JSON with the queries and all scored candidates (for tuning) |

To change any threshold or weight, record a fixture for the failing case and add it to the tests first (see Testing).

## Client (`src/client/`)

**Routing and data**
- **Routes** (react-router, declarative): `/` (login or playlist URL form) and `/playlists/:id`.
- **SWR**
  - The fetcher is `fetchJson`.
  - `revalidateOnFocus` is off, because the user returns from mora tabs constantly and refetching would waste Spotify quota.
  - Retries happen only on network errors or 5xx.
- **Request order:** `useMe()` must resolve before the playlist and items keys are enabled, to avoid the refresh-token race described above.
- **Items:** fetched under the key `["playlist-items", id]` by `fetchAllPlaylistItems`, which loops pages sequentially.

**Grouping (`lib/grouping.ts`)**
- Tracks are grouped by `album.id`, or `local:<album name>` for local files.
- Songs inside a group are ordered by `addedAt` descending; tracks added at the same time keep playlist order; a null `addedAt` sorts last.
- Groups are ordered by their newest track.

**Purchased marks (`lib/purchasedStore.ts`, `hooks/usePurchased.ts`)**
- Stored in localStorage under `spotify-shopping-cart:purchased` as `Record<trackUri, ISO time marked>`.
- A track counts as purchased only if `markedAt >= addedAt`, so a song re-added to the cart later shows up as unpurchased.
- Clicking any song's mora link (`onClick`, or `onAuxClick` with the middle button) marks every non-local track in that album group, because the link lands on the album page. Groups also have manual "Mark purchased" and "Undo" buttons.
- The hook uses `useSyncExternalStore` with an in-module listener set plus the `storage` event, so marks sync across tabs.

**Removal (`pages/PlaylistPage.tsx`, `components/RemoveDialog.tsx`)**
- Enabled only when `ownerId === me.id || collaborative`.
- Confirmed in a `<dialog>`, then posted in batches of 500.
- Each successful batch's marks are cleared immediately, so a partial failure leaves only the unremoved songs marked.
- The items cache is then pruned optimistically and revalidated.

**Styling**
- One plain stylesheet, `style.css`, light theme only. Don't add dark mode.
- Modern CSS is fine, including Baseline features of limited availability: nesting, `color-mix()`, `:has()`, `<dialog>`, range media queries.
- The layout targets a column of at most 880px and must work at phone width.

**CSP**
- `public/_headers` sets a CSP for asset responses: `script-src 'self'`, `style-src 'self'`, images from `*.scdn.co` and `*.spotifycdn.com`.
- `cf deploy` uploads it with the build. The Vite dev server ignores it, so it never breaks HMR.
- Avoid inline `style` attributes and inline scripts. Add any new image or CDN host to the CSP.

## Testing

- **Layout:** `bun test` runs everything under `test/`. Tests never live next to source files, because the worker and client programs would pick up `bun:test`.
- **Helpers**
  - `test/helpers/fetchMock.ts`: `mockFetch(handler)` spies on the global `fetch` and returns the captured requests. Call `mock.restore()` in `afterEach`.
  - `test/helpers/cookies.ts`: builds sealed session cookies and parses `Set-Cookie` headers.
  - `test/helpers/env.ts`: test `Bindings` and the origin `https://app.test`.
- **Worker tests** call `app.request(...)` with `TEST_ENV` and a mocked `fetch`. They cover OAuth, sessions, CSRF, the API, the mora client and matcher, and the redirector.
- **mora fixtures**
  - `test/fixtures/mora/responses.json` holds real `getResult` responses, trimmed to the fields the code uses and keyed by `"<searchKind> <keyWord>"`.
  - `cases.ts` lists the Spotify-side queries.
  - `record.ts` runs the matcher against live mora and rewrites the fixtures: `bun test/fixtures/mora/record.ts`.
  - Re-record whenever the matcher's queries change. Replay fails with a clear message naming any missing key.
- **Client:** only the pure modules are unit-tested (grouping, URL parsing, mora links, the purchased store). Components have no tests.
- **UI checks:** done manually with `playwright-cli` against the dev server, using `page.route` mocks for `/api/*` (and `context.route` for `/mora/redirect`, which opens in a new tab).
- **Before each commit:** `bun test && bun run typecheck && bun run build`.

## Conventions

- Commits follow sorah-guides commit style: a short lowercase-imperative or `component:` subject, and a body explaining why. Each commit is self-contained and passes all checks.
- TypeScript:
  - Prefer `type` over `interface`.
  - Use discriminated unions such as `MoraResolution` and `ParsedPlaylist`.
  - Use explicit `as T` casts for JSON instead of `any`.
  - Use custom `Error` subclasses for errors other code must recognise.
  - Indent with tabs.
- Comments explain only why something is non-obvious or record an external constraint; no change narration.
- Pages use default exports; everything else uses named exports.

## Unverified items and known limitations

**Not yet exercised with real Spotify credentials**
- The end-to-end OAuth flow.
- Whether `Accept-Language: ja` localizes names.
- Whether `DELETE /playlists/{id}/items` works for Development Mode apps. Community reports mention 403s, but those were on the removed endpoints.
- Whether mora answers requests from Cloudflare's egress IPs. Check with `/mora/redirect?...&debug=1` after deploying.

**Matching limitations**
- Romanized-artist matches often lack `trackMaterialNo`: the title-only track search is dominated by other artists.
- mora's caps of 12 packages and 10 tracks per query mean very common titles can push the right package out of the results. The track search and phase 2 mitigate this, but don't guarantee a match.

**Other limitations**
- The Cache API has no effect on `workers.dev`, so mora responses aren't cached.
- Local files can't be removed through the API.
- Removing by URI always deletes every duplicate of a track.

**Possible next steps**
- A custom domain (`domains` in `cloudflare.config.ts`) together with response caching for mora.
- A UI for `debug=1` output.
- Component tests.
