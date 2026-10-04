# Unverified items and known limitations

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
