# Spotify Web API (`src/worker/spotify.ts`, `src/worker/spotifyAccounts.ts`)

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
