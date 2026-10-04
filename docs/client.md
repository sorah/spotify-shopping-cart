# Client (`src/client/`)

**Routing and data**
- **Routes** (react-router, declarative): `/` (login or playlist URL form) and `/playlists/:id`.
- **SWR**
  - The fetcher is `fetchJson`.
  - `revalidateOnFocus` is off, because the user returns from mora tabs constantly and refetching would waste Spotify quota.
  - Retries happen only on network errors or 5xx.
- **Request order:** `useMe()` must resolve before the playlist and items keys are enabled, to avoid the refresh-token race described under Token refresh in [worker.md](worker.md).
- **Items:** fetched under the key `["playlist-items", id]` by `fetchAllPlaylistItems`, which loops pages sequentially.

**Grouping (`lib/grouping.ts`)**
- Tracks are grouped by `album.id`, or `local:<album name>` for local files.
- Songs inside a group are ordered by `addedAt` descending; tracks added at the same time keep playlist order; a null `addedAt` sorts last.
- Groups are ordered by their newest track.

**Purchased marks (`lib/purchasedStore.ts`, `hooks/usePurchased.ts`)**
- Stored in localStorage under `spotify-shopping-cart:purchased` as `Record<trackUri, ISO time marked>`.
- A track counts as purchased only if `markedAt >= addedAt`, so a song re-added to the cart later shows up as unpurchased.
- Clicking any song's mora link (`onClick`, or `onAuxClick` with the middle button) marks every non-local track in that album group, because the link lands on the album page. Groups also have manual "Mark purchased" (✓) and "Undo" (↺) icon buttons in a strip along the card's right edge.
- The hook uses `useSyncExternalStore` with an in-module listener set plus the `storage` event, so marks sync across tabs.
- `components/PurchasedPanel.tsx` lists the purchased songs by album (`purchasedGroups`), most recently marked album first so a misclick is at the top. Each song, and each album with more than one song, can be unmarked there.
- The action bar's "Unmark all" clears the panel's marks and offers Undo until anything is marked again. Undo restores the original mark times, so the panel order and the re-added check come back unchanged.

**Removal (`pages/PlaylistPage.tsx`, `components/RemoveDialog.tsx`)**
- Enabled only when `ownerId === me.id || collaborative`.
- Confirmed in a `<dialog>`, then posted in batches of 500.
- Each successful batch's marks are cleared immediately, so a partial failure leaves only the unremoved songs marked.
- The items cache is then pruned optimistically and revalidated.
- If any song was removed and the user owns the playlist, the client records the shopping with `PUT /api/playlists/:id/last-shopping` and puts the response into the playlist cache without revalidating. A failure there is only logged, because the songs are already gone.
- The playlist header shows the last shopping date and song count.

**Local library companion (`companion.ts`, `hooks/useCompanion.ts`, `lib/companion*.ts`, `components/Companion*.tsx`, `components/LocalMatchNote.tsx`)**
- Pairing, the status line, "Check local library" and the per-track review notes are described in [companion.md](companion.md#spa).
- `hooks/localStore.ts` holds the localStorage-backed store shared by the purchased marks and the companion's pairing and results.

**Debug export (`lib/debugExport.ts`, `components/DebugExportButton.tsx`)**
- The site footer's "Export debug data" button downloads a JSON file with every localStorage entry (JSON values parsed) and every SWR cache entry's `data` and `error`, plus the page URL and user agent.
- SWR cache entries are keyed by SWR's serialized key: `/api/me`, `/api/playlists/<id>`, and `@"playlist-items","<id>",` for the concatenated items pages.
- `Error` objects are exported with `name`, `message` and their own fields such as `status` and `code`.
- The session cookie is never read, and the companion pairing (`spotify-shopping-cart:companion`) is exported as `"[redacted]"`, so tokens never end up in the file.

**Styling**
- One plain stylesheet, `style.css`, light theme only. Don't add dark mode.
- Modern CSS is fine, including Baseline features of limited availability: nesting, `color-mix()`, `:has()`, `<dialog>`, range media queries.
- Pages use a column of at most 880px (`--content-width`). The playlist page widens it to 1200px and, from 960px up, shows the album list beside a sticky purchased panel. Everything must work at phone width.
- Below 960px the panel's `<aside>` is `display: contents`, so its action bar sticks to the viewport bottom across the whole album list.
- From 960px up, the playlist page drops `.site-main`'s bottom padding and the panel's `max-height` leaves `--footer-height` below it, so at the end of the page the footer fills exactly the panel's bottom gap and the panel doesn't slide under the header.

**CSP**
- `public/_headers` sets a CSP for asset responses: `script-src 'self'`, `style-src 'self'`, images from `*.scdn.co` and `*.spotifycdn.com`, and `connect-src` for the companion at `http://127.0.0.1:47611`.
- `cf deploy` uploads it with the build. The Vite dev server ignores it, so it never breaks HMR.
- Avoid inline `style` attributes and inline scripts. Add any new image or CDN host to the CSP.
