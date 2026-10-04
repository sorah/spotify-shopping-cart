# spotify-shopping-cart

This tool is for Spotify users who maintains a shopping cart playlist, which they intends to purchase a song later. We assume users is using Mora for purchasing songs primarily.

This tool allows user to:

1. login with spotify. Access token is stored as an encrypted cookie.
2. Load spotify playlist by URL. (and extract playlist ID)
3. Interact with the loaded playlist by:
   - Open a mora link for each song; Remember opened songs as purchased (in localStorage)
   - Bulk remove remembered purchased songs from the playlist.

For a mora link, each link is a redirector that: Search song in mora, do some fuzzy matching, and redirect to the best match mora link. For albums with standard and hi-res versions, the redirector prompts user to choose which version to open.

Playlist may contain multiple songs from the same album. it should be shown grouped. All groups and songs should be sorted by playlist_song_added_at desc. When remembering purchased songs, all songs from the same album should be remembered as purchased at once.

Tech stack: Bun, Cloudflare, TypeScript, Hono, React

## Setup

### Spotify app

Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) with the Web API enabled, and register these redirect URIs:

- `https://spotify-shopping-cart.<your trustless domain>:1443/auth/callback` for local development
- `https://<your worker host>/auth/callback` for production

Development Mode apps only work for users added under **User Management** (up to 5), and can only read and edit playlists the user owns or collaborates on.

### Local development

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in the Spotify client ID/secret; COOKIE_ENCRYPTION_KEY from `openssl rand -base64 32`
bun run dev                      # serves https://spotify-shopping-cart.<domain>:1443 via trustless
```

`bun run dev` runs Vite under [trustless](https://github.com/sorah/trustless), which provides the HTTPS origin Spotify requires for redirect URIs.

```sh
bun test
bun run typecheck
bun test/fixtures/mora/record.ts   # re-record mora search fixtures after changing the matcher's queries
```

### Deployment

Put `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and a fresh `COOKIE_ENCRYPTION_KEY` in a git-ignored file such as `.env.production`, then:

```sh
bun run deploy --secrets-file .env.production
```

The secrets file is required on the first deploy; later deploys keep existing secrets unless a file is passed again.
