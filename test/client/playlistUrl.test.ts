import { describe, expect, test } from "bun:test";
import { parsePlaylistInput } from "../../src/client/lib/playlistUrl.ts";

const ID = "37i9dQZF1DXcBWIGoYBM5M";

describe("parsePlaylistInput", () => {
	test.each([
		[ID],
		[`  ${ID}  `],
		[`spotify:playlist:${ID}`],
		[`https://open.spotify.com/playlist/${ID}`],
		[`https://open.spotify.com/playlist/${ID}?si=abc123`],
		[`https://open.spotify.com/intl-ja/playlist/${ID}`],
		[`https://open.spotify.com/intl-pt-br/playlist/${ID}/`],
		[`https://open.spotify.com/user/someone/playlist/${ID}`],
		[`http://open.spotify.com/playlist/${ID}#x`],
	])("accepts %p", (input) => {
		expect(parsePlaylistInput(input)).toEqual({ kind: "ok", id: ID });
	});

	test.each([
		["https://spotify.link/AbCdEf", "Short links"],
		[`https://open.spotify.com/album/${ID}`, "doesn't look like"],
		[`https://evil.example/playlist/${ID}`, "doesn't look like"],
		["not a url", "Paste a Spotify playlist link"],
		["", "Paste a Spotify playlist link"],
	])("rejects %p", (input, message) => {
		const result = parsePlaylistInput(input);
		expect(result.kind).toBe("error");
		expect(result.kind === "error" && result.message).toContain(message);
	});
});
