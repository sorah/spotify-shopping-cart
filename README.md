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
