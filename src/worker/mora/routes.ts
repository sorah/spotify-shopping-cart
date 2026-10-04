import { Hono } from "hono";
import { html } from "hono/html";
import type { ApiError } from "../../shared/types.ts";
import type { AppEnv } from "../env.ts";
import { readSession } from "../session.ts";
import { MoraError, moraSearch } from "./client.ts";
import { type Edition, type MoraQuery, resolveMora, searchPageUrl } from "./match.ts";

const MAX_PARAM_LENGTH = 200;
const MAX_ARTISTS = 10;

export const mora = new Hono<AppEnv>();

function parseQuery(params: URLSearchParams): MoraQuery | undefined {
	const title = params.get("title") ?? "";
	const album = params.get("album") ?? "";
	const artists = params.getAll("artist");
	const albumArtists = params.getAll("albumArtist");
	const tracks = params.get("tracks");
	const values = [title, album, ...artists, ...albumArtists];
	if (title === "" || values.some((value) => value.length > MAX_PARAM_LENGTH)) return undefined;
	if (artists.length > MAX_ARTISTS || albumArtists.length > MAX_ARTISTS) return undefined;
	const totalTracks = tracks ? Number(tracks) : null;
	if (totalTracks !== null && !Number.isSafeInteger(totalTracks)) return undefined;
	return { title, album, artists, albumArtists, totalTracks };
}

// Requires a session so the endpoint cannot be used as an anonymous proxy to mora.
mora.get("/redirect", async (c) => {
	const url = new URL(c.req.url);
	if (!(await readSession(c))) {
		return c.redirect(`/auth/login?${new URLSearchParams({ return_to: url.pathname + url.search })}`);
	}

	const query = parseQuery(url.searchParams);
	if (!query) return c.json<ApiError>({ code: "bad_request", message: "invalid track parameters" }, 400);

	let resolution: Awaited<ReturnType<typeof resolveMora>>;
	try {
		resolution = await resolveMora(query, moraSearch);
	} catch (error) {
		if (!(error instanceof MoraError)) throw error;
		console.error(error);
		return c.redirect(searchPageUrl(`${query.artists[0] ?? ""} ${query.title}`.trim()));
	}

	if (url.searchParams.has("debug")) return c.json(resolution);
	if (resolution.kind === "search") return c.redirect(resolution.url);
	if (resolution.editions.length === 1) return c.redirect(resolution.editions[0]!.url);
	return c.html(chooserPage(query, resolution.editions));
});

export function formatLabel({ mediaFormatNo, samplingFreq, bitPerSample }: Edition): string {
	const khz = samplingFreq ? `${samplingFreq / 1000}kHz` : "";
	switch (mediaFormatNo) {
		case 10:
			return "AAC 320kbps";
		case 15:
			return `Lossless FLAC ${bitPerSample ?? 16}bit/${khz || "44.1kHz"}`;
		case 12:
			return `Hi-Res FLAC ${bitPerSample ? `${bitPerSample}bit/` : ""}${khz}`;
		case 13:
			return `DSD ${samplingFreq ? `${(samplingFreq / 1_000_000).toFixed(1)}MHz` : ""}`.trim();
		default:
			return `Format ${mediaFormatNo}`;
	}
}

function chooserPage(query: MoraQuery, editions: Edition[]) {
	const searchUrl = searchPageUrl(`${query.artists[0] ?? ""} ${query.title}`.trim());
	return html`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Choose an edition - ${query.title}</title>
		<style>
			body { font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #f7f7f5; color: #1c1c1c; margin: 0; padding: 32px 16px; }
			main { max-width: 560px; margin: 0 auto; }
			h1 { font-size: 1.25rem; margin: 0 0 4px; }
			p { margin: 0 0 20px; color: #555; }
			ul { list-style: none; margin: 0 0 24px; padding: 0; display: grid; gap: 8px; }
			a.edition { display: grid; gap: 2px; padding: 14px 16px; border-radius: 10px; background: #fff; border: 1px solid #e2e2de; color: inherit; text-decoration: none; }
			a.edition:hover { border-color: #e4007f; }
			.format { font-weight: 600; }
			.meta { font-size: 0.875rem; color: #666; }
		</style>
	</head>
	<body>
		<main>
			<h1>Choose an edition on mora</h1>
			<p>${query.title}${query.artists.length > 0 ? ` - ${query.artists.join(", ")}` : ""}</p>
			<ul>
				${editions.map(
					(edition) => html`<li>
					<a class="edition" href="${edition.url}">
						<span class="format">${formatLabel(edition)}</span>
						<span>${edition.packageTitle} / ${edition.artistName}</span>
						<span class="meta">${edition.packageTrack === null ? "" : `${edition.packageTrack} tracks, `}released ${edition.startDate.slice(0, 10)}</span>
					</a>
				</li>`,
				)}
			</ul>
			<a href="${searchUrl}">Search on mora instead</a>
		</main>
	</body>
</html>`;
}
