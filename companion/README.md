# ssc-companion

Local library companion for spotify-shopping-cart. It runs on the music PC, indexes the local libraries (an iTunes library XML and plain folders), and answers the app's "do I already own these?" requests on `http://127.0.0.1:47611`. [docs/companion.md](../docs/companion.md) covers the design and protocol v1.

The companion only reads the libraries. Its state lives in its data directory (`%LOCALAPPDATA%\ssc-companion\` on Windows), and the HTTP API never accepts or returns local paths.

## Setup

Requires Rust stable and `ffprobe` on `PATH` (or `"ffprobe": "<path>"` in the config).

```sh
cargo build --release
```

Copy [config.example.json](config.example.json) to `%LOCALAPPDATA%\ssc-companion\config.json` and adjust the sources:

| Field | Default | |
|---|---|---|
| `listen` | | Loopback address; the app expects `127.0.0.1:47611` |
| `allowedOrigins` | | Exact origins allowed to call the API |
| `sources[]` | | `{id, label?, type: "itunes-xml" \| "directory", path, extensions?}`; `label` is shown in the app instead of the path |
| `exclude[]` | `[]` | `{source, pathGlob, reason?}`; globs match paths relative to the source root, case-insensitively |
| `ffprobe` | `"ffprobe"` | ffprobe executable |
| `scanConcurrency` | `8` | Parallel file reads and ffprobe processes |
| `rescanIntervalSecs` | `300` | How often to check the sources for changes |
| `itunesLookup` | `{enabled: true, country: "jp", intervalMs: 3500}` | Store-name resolution for purchased tracks |

## Usage

```sh
ssc-companion serve                # default; prints the pairing token at startup and when the app asks unpaired
ssc-companion token                # print the pairing token again
ssc-companion token --rotate       # replace it; restart serve, then pair the app again
ssc-companion match --export spotify-shopping-cart-debug-<time>.json [--offline] [--verbose]
```

`match` indexes the libraries like `serve` does, matches a playlist from the app's debug export, and prints the verdict counts.

The data directory holds `config.json`, `token`, `id-key` (the key for opaque folder-entry IDs) and `cache.sqlite3`. The cache can be deleted at any time. Rebuilding it takes about a minute of scanning plus a few minutes of iTunes Lookup.

## Development

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
bun scripts/gen-normalize-fixtures.ts   # after src/worker/mora/normalize.ts changes
```

`src/normalize.rs` ports `src/worker/mora/normalize.ts`. `tests/normalize_parity.rs` compares the two through fixtures generated from the corpus in `tests/fixtures/normalize-corpus.json`.
