# Local library companion

> **Status:** the companion (Rust) is in [`companion/`](../companion/README.md) and verified on the music PC. The SPA has run only against a mock companion so far, because the SPA and Worker are developed on another machine.

## Goal

The shopping-cart playlist accumulates songs the user already owns locally. The companion lets the SPA ask "do I already have these?" for the whole playlist in one or two requests. It automatically marks the songs it is confident about as purchased and lists the uncertain ones for review. The existing bulk removal ([client.md](client.md)) then cleans them out.

## Hard constraint: read-only

**The companion never modifies, moves, renames, retags or deletes anything in the music libraries.**

- Sources are only read: the iTunes XML as text, and audio files through `ffprobe`, `stat` and ranged reads of MP4 `moov` boxes.
- The companion's caches (index, iTunes Lookup results, pairing token) live in its own directory, `%LOCALAPPDATA%\ssc-companion\`.
- No endpoint accepts a filesystem path or performs a file operation. `location` in responses is a display label, not a usable path.
- Cleanup happens only on the Spotify playlist, through the existing `/api/playlists/:id/remove`.

## Topology

```
Browser (SPA)  https://spotify-shopping-cart.nkmi.me
               https://spotify-shopping-cart.lo.nkmiusercontent.com:1443 (dev)
  │  fetch, CORS, Authorization: Bearer <pairing token>
  ▼
Companion  http://127.0.0.1:47611   (Rust, companion/, on the music PC)
  ├─ D:\iTunes_cloud\iTunes Library.xml    (re-parsed when its mtime changes)
  ├─ iTunes .m4a files                     (MP4 atoms: store IDs, ISRC, mora IDs)
  ├─ X:\music-rip\library                  (ffprobe tags, cached by path+size+mtime)
  └─ itunes.apple.com/lookup?country=jp    (store ID → content-language names; cached forever)
```

**Transport**
- The Worker is not involved, because a Cloudflare Worker cannot reach the user's loopback.
- The address is `127.0.0.1`, never `localhost`. Loopback counts as a trustworthy origin, so an HTTPS page may fetch it without mixed-content blocking. The fetch needs no `targetAddressSpace` option, since a literal loopback IP is already in the loopback address space.
- Chrome 142+ asks once for the `loopback-network` permission. A denied permission looks like a network failure to the page. Safari blocks the request entirely, so the feature is Chromium/Firefox-only.
- The port is fixed at 47611, because the CSP is static. `public/_headers` therefore has `connect-src 'self' http://127.0.0.1:47611`, and the SPA hardcodes `COMPANION_ORIGIN`.

**CORS and auth**
- CORS allows exactly the two origins above, methods `GET, POST`, and headers `Authorization, Content-Type`. The companion also answers the legacy PNA preflight header with `Access-Control-Allow-Private-Network: true`; current Chrome no longer uses it, but it's harmless.
- The companion generates a random token on first run and prints it in its console at every start. It also prints it when an allowlisted origin sends a request without a valid token, at most once every 10 s. The SPA stores the token in localStorage `spotify-shopping-cart:companion` as `{token}` and redacts it from debug exports.
- The companion rejects any request whose `Origin` isn't allowlisted or whose token doesn't match, so no other website can probe the library.
- The SPA can't authenticate the companion. While it isn't running, another local process listening on 127.0.0.1:47611 would receive the token.

## Running

Setup, configuration options and development commands are in [companion/README.md](../companion/README.md).

- `ssc-companion serve` starts the server (`companion\target\release\ssc-companion.exe` on the music PC); `ssc-companion token` prints the pairing token.
- `ssc-companion token --rotate` replaces the token; a running `serve` keeps the old one until restarted.
- The first start scans for about 60 s. Until the first index is ready, `/v1/match` answers 503 `indexing` and `/v1/status` shows the sources `indexing` with progress. Later starts load the index from cache in about 2 s.
- The first iTunes Lookup run then takes about 3 minutes. When it finishes, the index is republished with a new `libraryRevision`.
- Library changes are picked up by polling every 5 minutes.
- `libraryRevision` is a content hash, so a restart with an unchanged library keeps it and the SPA's cached results stay valid.

## Companion configuration

`%LOCALAPPDATA%\ssc-companion\config.json` holds machine-specific exceptions, so they stay out of the code:

```json
{
	"listen": "127.0.0.1:47611",
	"allowedOrigins": [
		"https://spotify-shopping-cart.nkmi.me",
		"https://spotify-shopping-cart.lo.nkmiusercontent.com:1443"
	],
	"sources": [
		{ "id": "itunes", "type": "itunes-xml", "path": "D:/iTunes_cloud/iTunes Library.xml" },
		{ "id": "rip", "type": "directory", "path": "X:/music-rip/library", "extensions": ["flac", "mp3", "m4a", "wav"] }
	],
	"exclude": [
		{ "source": "rip", "pathGlob": "**/SoundCloud/**", "reason": "bootlegs and mashups, not purchasable releases" }
	]
}
```

`exclude` globs match paths relative to the source root. Matching never reads values from directory names; the globs are used only to drop files.

## What the local data looks like (surveyed 2026-10-05)

### iTunes library

**Entries.** 23,292 audio entries (videos, TV shows and podcasts excluded). 98 are cloud-only (`Track Type` `Remote`).

**XML fields.** `Name`, `Artist`, `Album Artist`, `Album`, `Total Time` (ms), `Track Number`, `Disc Number`, `Persistent ID`, `Kind`, plus the flags `Purchased`, `Matched` and `Apple Music`. Strings contain entities such as `&#38;`, and some `Kind` values are localized (`購入したAACオーディオファイル`). The XML equals the files' own tags; there's no extra metadata in the XML.

**Store IDs in purchased files.** Purchased `.m4a` files carry iTunes Store atoms:
- `cnID`: store track ID
- `plID`: store album ID
- `atID`: artist ID
- `xid`: `<label>:isrc:<ISRC>`

Never read or log `apID` and `ownr`: they contain the account owner.

| Kind | Files | `cnID` | ISRC (`xid`) | Ownership |
|---|---|---|---|---|
| Purchased AAC (including the localized label) | 9,270 | 9,230 | 3,870 | purchased |
| Matched AAC (iTunes Match) | 3,634 | 574 | 1 | matched (owned) |
| AAC (imported/ripped) | 7,206 | 58 | – | imported (owned) |
| MPEG | 3,079 | – | – | imported (owned) |
| Protected AAC, AIFF, ALAC | 9 | – | – | owned |
| **Apple Music AAC** | 29 | 4 | 4 | **subscription: never `owned`** |

`cnID` can be the placeholder `4294967295`; skip it.

**Language divergence.** iTunes Store downloads take metadata in the app's language, not the content's. About half of the purchases that are still listed carry romanized or English names locally:

| Local tags | Japan store (`lookup?country=jp`) |
|---|---|
| Umibede Aimashou · Mikako Komatsu | 海辺で逢いましょう · 小松未可子 |
| Happy Merry-Go-Round! · Ayaka Ohashi · You & I - Single | ハッピーメリーゴーランド! · 大橋彩香 · ユー&アイ - Single |
| Twilit Terraces / 落日の都 ～ラザハン～ · Masayoshi Soken | 落日の都 〜ラザハン〜 · 祖堅正慶 |

Spotify returns the content-language names, like the Japan store does.

**Resolving store names.** The companion resolves each `cnID` once through `https://itunes.apple.com/lookup?country=jp&id=<up to 200 comma-separated IDs>` and caches the result permanently.
- Only catalog IDs are sent.
- The `lang` parameter makes no difference with `country=jp`.
- A 400 for a batch means one bad ID; bisect to find it.
- Throttle to about one request every 3.5 s.
- 7,056 of 9,768 IDs resolved; the rest are delisted, and their local tags are the only names.
- Lookup by ISRC isn't supported. Lookup by album ID (`entity=song`) works for albums still listed.

**mora downloads in iTunes.** About 90 imported AAC files are mora downloads. They carry 3GPP tags (`titl`, `perf`, `albm`, `dscp` = `JASRAC / <label>`) and `uuid` boxes holding mora IDs (see below).

### Rip library

**Files.** 3,340 audio files; 1,345 are excluded by the SoundCloud glob.
- Formats: 2,139 FLAC 44.1k/16, 246 FLAC 48k/24, 704 MP3, 116 M4A, 28 WAV.
- Tags are read with `ffprobe -show_entries format=duration:format_tags`; tag keys vary in case. After the exclusion, every file has an artist tag.
- Duplicate copies exist (`.flac.flac`, `… のコピー.flac`, `(2)`). They simply show up as extra `matches`.

**mora downloads.** 42 FLACs carry mora's IDs as Vorbis comments keyed by UUID. The iTunes AAC files carry the same UUIDs as `uuid` boxes (16-byte UUID, a 4-byte `a01x` tag, 8 header bytes, then a text value):

| UUID key | Meaning | Example |
|---|---|---|
| `45b1d925-1448-5784-b4da-b89901050a13` | mora `labelCode` | `10006001` |
| `8e90f26b-372a-5c8c-bb05-1ec0f36ee60c` | mora `packageId` | `TCJPS0003693263_hires`, `CVRD-616-01` |
| `be242671-3d48-5ac8-b762-7d2db4f584b8` | mora track `materialNo` | `35843225` |
| `93a74bea-ce97-5571-a56a-c5084dba9873` | ISRC | `TCJPK2576742` |
| `ff8ca75f-2d68-52eb-85d6-1580486025a4` | unknown (shared across packages) | `102296892` |

These give `https://mora.jp/package/<labelCode>/<packageId>/` (see Package URLs in [mora.md](mora.md)).

## Protocol v1

The SPA's copy of these types is `src/client/lib/companionProtocol.ts`.

**Negotiation**
1. `GET /v1/status` runs once `/api/me` has resolved and a token is stored.
2. The client picks the highest version in `protocols ∩ [1]`. If there is none, it asks the user to update the companion or the app.
3. Every later body carries `protocol: <chosen>`.
4. Both sides ignore unknown fields, so additive changes don't bump the version. `capabilities` gates optional UI.

### `GET /v1/status`

```ts
type CompanionStatus = {
	protocols: number[]; // [1]
	version: string;
	libraryRevision: string; // changes when the index changes; key client caches on it
	capabilities: string[]; // "match", "ids.isrc", "ids.itunes", "ids.mora", "store-metadata"
	sources: {
		id: string; // the source id from config.json; display `label`
		label: string;
		state: "ready" | "indexing" | "error";
		entries: number;
		indexedAt: string | null;
		progress?: { done: number; total: number };
		error?: string;
	}[];
};
```

### `POST /v1/match`

Takes at most 500 tracks and a 2 MiB body per request; 500 real tracks are about 300 KB. The SPA dedupes by URI, drops local files, and chunks. The companion runs at most 2 match requests at once and queues the rest. Matching uses only the title, the album and the first 16 artists, each cut to 512 characters after NFKC.

```ts
type MatchRequest = {
	protocol: 1;
	tracks: {
		key: string; // Spotify track URI, echoed back
		title: string; // PlaylistTrack.name
		artists: string[];
		album: { id: string | null; title: string; artists: string[]; totalTracks: number | null };
		durationMs: number | null;
		isrc: string | null;
		trackNumber: number | null;
		discNumber: number | null;
	}[];
};

type MatchResponse = {
	protocol: 1;
	libraryRevision: string;
	results: MatchResult[]; // same order and length as the request
};

type MatchResult = {
	key: string;
	verdict: "owned" | "probable" | "absent";
	score: number; // 0..1, best candidate
	matchedBy: "isrc" | "store-id" | "metadata" | null;
	matches: LocalMatch[]; // best first, at most 3; [] when absent
};

type LocalMatch = {
	source: string; // a sources[].id from /v1/status
	id: string; // opaque: iTunes Persistent ID or a hash of the path within a directory source
	title: string;
	artists: string[];
	album: string | null;
	durationMs: number | null;
	ownership: "purchased" | "matched" | "imported" | "flat" | "apple-music"; // "flat": a file from a directory source
	format: string;
	cloudOnly: boolean;
	location: string; // display label only
	metadataSource: "tags" | "itunes-store"; // which name set produced the match
	ids: {
		isrc?: string;
		itunesTrackId?: number;
		itunesCollectionId?: number;
		mora?: { labelCode: string; packageId: string; materialNo: string };
	};
	score: number;
	signals: {
		title: number;
		artist: number;
		album: number | null;
		durationDeltaMs: number | null;
		isrc: boolean | null;
	};
};
```

**Field values from the companion**
- `artists` has exactly one element, the display artist.
- `id` is the iTunes Persistent ID for iTunes entries, and a 16-hex-digit hash for directory entries.
  - A Persistent ID changes only when the track is removed and re-imported.
  - A directory ID hashes the source id and the relative path with a per-install key (the `id-key` file, which survives deleting `cache.sqlite3`). Moving or renaming the file, changing the source id, or deleting `id-key` changes it.
  - Dismissals key on these IDs, so a dismissed match can return through a duplicate copy of the same song.
- `matches[0]` of an `owned` result is the entry that decided the verdict, such as the ISRC hit, even when another entry scores higher.
- `format` for iTunes entries is a label derived from `Kind`: `AAC`, `MP3`, `ALAC`, `AIFF`, `WAV` or `other`. Directory entries report their file extension (`FLAC`, `MP3`, `M4A`, `WAV`).
- `location` is `<source label> · <artist> / <album>`, from tags only.

**Errors** have the body `{protocol: 1, code, message?}`, with CORS headers on every response to an allowlisted origin.

| Status | `code` | Client behaviour |
|---|---|---|
| network failure | – | quiet "companion not running" state |
| 400 | `bad_request` | client bug; malformed JSON |
| 401 | `unpaired` | ask for the token again; the companion prints it in its console |
| 403 | `origin_not_allowed` | configuration error; sent without CORS headers, so the SPA sees a network failure |
| 404 | `not_found` | unknown path |
| 409 | `protocol_mismatch` | ask the user to update |
| 413 | `too_many_tracks` | client bug; chunk to 500 |
| 500 | `internal_error` | companion bug |
| 503 | `indexing` | poll `/v1/status` until `ready` |

## Matching

**Name sets.** Each local entry carries one or two name sets: its tags, and (when the `cnID` resolves) the Japan-store names. Every set is scored, and the best one wins; `metadataSource` reports which.

**Candidates**
- Exact hits on `fullKey`/`baseKey` of the title, from `src/worker/mora/normalize.ts`.
- Plus the top 200 by title-bigram overlap.

**Artist credits** are expanded into variants before comparing with `artistSim`:
- `キャラ (声優)`, `キャラ(CV:声優)`, `キャラ（CV：声優）`: both the character and the voice actor.
- `X starring Y`: both names.
- Lists split on `, 、 & × / feat. with x vs.`: each member.

**Verdicts** (first rule that applies)

| Verdict | Condition |
|---|---|
| `owned`, `matchedBy: "isrc"` | the Spotify ISRC equals a local ISRC (`xid` or mora). Case-insensitive. |
| `owned`, `matchedBy: "metadata"` | title ≥ 0.92, artist ≥ 0.8, album ≥ 0.8, and \|Δduration\| ≤ 3 s when both durations are known |
| `probable` | title ≥ 0.85 and artist ≥ 0.5; or title ≥ 0.92 and \|Δduration\| ≤ 1.5 s (catches romanized artists with no store ID, e.g. "illumination STARS") |
| `absent` | otherwise |

An `apple-music` entry never makes a track `owned`.

**Prototype results.** Against the real playlist (2026-10-04 debug export, 699 unique tracks), with metadata only because that export predates the ISRC and duration fields (a later export has both for every track):

| | owned | probable | absent |
|---|---|---|---|
| Local tags only, loose rules | 125 | 12 | 562 |
| **Tags + Japan-store names, rules above** | **150** (93 via tags, 57 via store names) | 30 | 519 |
| Same, on the 2026-10-05 export with ISRC and duration | 155 (55 by ISRC, 100 by metadata) | 38 (28 by title and artist, 10 by duration only) | 506 |

Spot checks of the second run:
- The store names add correct matches that local tags miss (青の一コマ is tagged "Akari Kito" locally).
- The store names also pick the right recording where tags alone picked the wrong one: Project Sekai another-vocal versions now match the local another-vocal album instead of the group version.
- `probable` is mostly the same song on a different release (a single vs an album). ISRC should turn many of those into `owned`.
- Same-title `absent` cases checked so far are covers or different songs by other artists, as expected.

With ISRC and duration:
- 50 of the 55 ISRC hits were already owned by metadata. ISRC added the ones romanized tags hide (キスキツネ tagged "Kiss Kitsune", ダブル・イフェクト tagged "Double Effect") and one mora FLAC from the rip library. Duration deltas on ISRC hits are at most 62 ms.
- The ±3 s guard on metadata `owned` blocked nothing; the largest delta there was 2.0 s.
- About half of the duration-only `probable` matches are wrong: Project Sekai another-vocal vs group versions, and covers by other artists, 0.24–1.5 s apart. The rest are romanized artists (UraraNanami) and credit mismatches. The rule stays because `probable` is review-only, and the review note shows the local artist and the duration difference to the tenth of a second.

## SPA

The code is in `src/client/`: `companion.ts` (HTTP), `lib/companionMatch.ts` (check, cache and review logic), `hooks/useCompanion.ts` and `components/Companion*.tsx`.

**Pairing**
- "Local library companion" in the site footer (shown when logged in) and "Settings" in the playlist page's Local library card open the same dialog. It takes the token, shows the companion's status, and can unpair.
- While no token is stored, opening the dialog sends `GET /v1/status` without `Authorization`, which makes the companion print its token, and tells the user to copy it from the console window. The probe needs the browser to run on the same machine as the companion.
- The status line is mounted only while the dialog is open or the card is shown, so pages without the card never trigger the local network permission prompt.

**Status**
- SWR key `companion:/v1/status`, enabled once `/api/me` resolves and a token is stored. The key carries no token, because the debug export dumps the SWR cache.
- Errors aren't retried, so a stopped companion stays a quiet grey status line. While any source is indexing, the status is polled every 2 s and "Check local library" is disabled.

**Check (`checkLibrary`)**
1. Fetches `/v1/status` again and negotiates the protocol.
2. Reuses cached results from the same `libraryRevision`, and sends only the remaining tracks, in chunks of 500.
3. If a response carries a different revision, a re-index finished mid-check, so the check starts over (at most 3 attempts).
4. Results are kept in localStorage `spotify-shopping-cart:companion-matches` as `{libraryRevision, results, dismissed}`. Only the tracks of the checked playlist are kept.

**Verdicts in the UI**
- **`owned`:** every check marks the owned tracks that aren't marked yet, one by one, whether the result is fresh or cached. Never expand to the album group as the mora click does: owning one song says nothing about the rest. The track row shows an "In your library" badge. Its "Not this one" unmarks the track and dismisses the match, so later checks leave the track alone. Unmarking in the purchased panel doesn't dismiss, so the next check marks the track again.
- **`probable`:** the track row shows the best match: title and artists, `location`, ownership, format, duration difference and `matchedBy`, plus a link to the mora package page when the status has the `ids.mora` capability. "Mark purchased" marks the track; "Not this one" stores a dismissal keyed by `(uri, match.id)`. A different best match after a re-index shows up again.
- **`absent`:** nothing.
- Results from another library revision than the current status are hidden, and the card asks for a new check. The status is refetched on window focus to notice re-indexes. When the companion isn't reachable, the cached results are still shown.
- The card's summary reads "Found 150 owned, 30 to review in 699 songs". "30 to review" cycles through the review notes on the page.

## Worker

`PlaylistTrack` has `durationMs`, `trackNumber`, `discNumber` and `isrc` for the match request (see [spotify.md](spotify.md)).
