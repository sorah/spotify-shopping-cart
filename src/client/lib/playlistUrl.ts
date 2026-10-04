const ID_RE = /^[A-Za-z0-9]{22}$/;
const URI_RE = /^spotify:playlist:([A-Za-z0-9]{22})$/;
const PATH_RE = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:user\/[^/]+\/)?playlist\/([A-Za-z0-9]{22})\/?$/;
const SHORT_LINK_HOSTS = ["spotify.link", "spotify.app.link"];

export type ParsedPlaylist = { kind: "ok"; id: string } | { kind: "error"; message: string };

export function parsePlaylistInput(input: string): ParsedPlaylist {
	const text = input.trim();
	if (ID_RE.test(text)) return { kind: "ok", id: text };
	const uri = URI_RE.exec(text);
	if (uri) return { kind: "ok", id: uri[1]! };

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { kind: "error", message: "Paste a Spotify playlist link, e.g. https://open.spotify.com/playlist/…" };
	}
	if (SHORT_LINK_HOSTS.includes(url.hostname)) {
		return {
			kind: "error",
			message: "Short links aren't supported. Open it in a browser and copy the open.spotify.com URL.",
		};
	}
	const path = url.hostname === "open.spotify.com" ? PATH_RE.exec(url.pathname) : null;
	if (!path) return { kind: "error", message: "That doesn't look like a Spotify playlist link." };
	return { kind: "ok", id: path[1]! };
}
