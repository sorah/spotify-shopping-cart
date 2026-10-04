# Worker (`src/worker/`)

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/login?return_to=` | – | Start OAuth: sets a sealed state cookie and redirects (302) to Spotify authorize |
| `GET /auth/callback` | state cookie | Exchange the code and set the session cookie; redirect (302) to `return_to`, or to `/?auth_error=<code>` on failure |
| `POST /auth/logout` | same-origin | Clear the session; 303 to `/` |
| `GET /api/me` | session | `{id, displayName}` |
| `GET /api/playlists/:id` | session | Playlist metadata |
| `GET /api/playlists/:id/items?offset=` | session | One normalized page of 50 items, plus `nextOffset` |
| `POST /api/playlists/:id/remove` | session, same-origin, JSON | `{uris}`, at most 500 per request; removes them from the playlist |
| `GET /mora/redirect?...` | session cookie | mora redirector (see [mora.md](mora.md)) |

Middleware applied to these routes:

- `secureHeaders()` on all Worker responses.
- `Cache-Control: no-store` on `/api`, `/auth` and `/mora`.
- `onError` in `index.ts` maps `SpotifyApiError`/`SpotifyTokenError`/`ForbiddenError` to `ApiError` JSON. Error codes are defined in `src/shared/types.ts`, and the client turns each one into a user-facing message in `ApiErrorNotice.tsx`.

The Spotify Web API facts the `/api` routes depend on are in [spotify.md](spotify.md).

## Cookies and session (`cookieCrypto.ts`, `session.ts`, `auth.ts`)

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
