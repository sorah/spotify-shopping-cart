# mora redirector (`src/worker/mora/`)

## mora facts (verified live)

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

## Request

`/mora/redirect?title=&album=&artist=…&albumArtist=…&tracks=<album total_tracks>`

- `artist` and `albumArtist` may repeat. Each value is limited to 200 characters, with at most 10 artists.
- The client builds these URLs in `src/client/lib/mora.ts`.
- A decryptable session cookie is required, so the route can't be used as an anonymous proxy to mora. Without one it redirects to `/auth/login?return_to=…`. Spotify is never called, so a session whose access token has expired still works.

## Matching (`normalize.ts`, `romanize.ts`, `match.ts`)

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
- The local library companion's `companion/src/normalize.rs` ports this module. Regenerate its parity fixtures after changing it (see [companion/README.md](../companion/README.md#development)).

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

To change any threshold or weight, record a fixture for the failing case and add it to the tests first (see mora fixtures in [testing.md](testing.md)).
