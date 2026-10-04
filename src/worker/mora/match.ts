import type { MoraPackageHit, MoraSearch, MoraTrackHit } from "./client.ts";
import { artistSim, fullKey, keywordTitle, titleSim } from "./normalize.ts";

export type MoraQuery = {
	title: string;
	artists: string[];
	album: string;
	albumArtists: string[];
	totalTracks: number | null;
};

export type Edition = {
	url: string;
	labelCode: string;
	packageId: string;
	packageTitle: string;
	artistName: string;
	mediaFormatNo: number;
	samplingFreq: number | null;
	bitPerSample: string | null;
	packageTrack: number | null;
	startDate: string;
	trackMaterialNo: number | null;
};

export type ScoredCandidate = {
	key: string;
	artistName: string;
	packageTitle: string;
	mediaFormatNo: number;
	album: number;
	artist: number;
	trackFound: boolean;
	trackCount: number;
	score: number;
	isAccepted: boolean;
};

export type MatchDebug = {
	queries: string[];
	candidates: ScoredCandidate[];
};

export type MoraResolution =
	| { kind: "editions"; editions: Edition[]; debug: MatchDebug }
	| { kind: "search"; url: string; debug: MatchDebug };

const VIDEO_FORMAT = 11;
const FORMAT_ORDER = [10, 15, 12, 13];
const TRACK_MATCH_THRESHOLD = 0.85;
const ARTIST_MATCH_THRESHOLD = 0.5;
const LABEL_CODE_RE = /^\d+$/;
const PACKAGE_ID_RE = /^[\w.-]+$/;

type Candidate = {
	hit: MoraPackageHit;
	trackHits: MoraTrackHit[];
};

const keyOf = (hit: MoraPackageHit) => `${hit.labelCode}/${hit.packageId}`;
const editionGroupOf = (hit: MoraPackageHit) => `${fullKey(hit.artistName)}\n${fullKey(hit.packageTitle)}`;

function addCandidate(candidates: Map<string, Candidate>, hit: MoraPackageHit, trackHit?: MoraTrackHit) {
	if (hit.mediaFormatNo === VIDEO_FORMAT) return;
	const key = keyOf(hit);
	const existing = candidates.get(key);
	if (!existing) {
		candidates.set(key, { hit, trackHits: trackHit ? [trackHit] : [] });
		return;
	}
	if (existing.hit.packageTrack === null && hit.packageTrack !== null) existing.hit = hit;
	if (trackHit) existing.trackHits.push(trackHit);
}

async function searchWithFallback<T extends MoraPackageHit>(
	search: (keyWord: string) => Promise<T[]>,
	query: MoraQuery,
	artist: string,
	title: string,
	debug: MatchDebug,
	kind: string,
): Promise<T[]> {
	const keyWord = `${artist} ${title}`.trim();
	debug.queries.push(`${kind}: ${keyWord}`);
	const hits = await search(keyWord);
	if (keyWord === title || hits.some((hit) => artistScore(query, hit) >= ARTIST_MATCH_THRESHOLD)) return hits;
	// A romanized Spotify artist name finds nothing, or only covers that mention it.
	debug.queries.push(`${kind}: ${title}`);
	return [...hits, ...(await search(title))];
}

function trackCountScore(expected: number | null, actual: number | null): number {
	if (expected === null || actual === null) return 0.5;
	const diff = Math.abs(expected - actual);
	return diff === 0 ? 1 : diff <= 2 ? 0.6 : 0;
}

function artistScore(query: MoraQuery, hit: MoraPackageHit): number {
	return Math.max(
		artistSim(query.artists, hit.artistName, hit.artistNameKana),
		artistSim(query.albumArtists, hit.artistName, hit.artistNameKana),
	);
}

function scoreCandidate(query: MoraQuery, { hit, trackHits }: Candidate): ScoredCandidate {
	const album = titleSim(query.album, hit.packageTitle);
	const artist = artistScore(query, hit);
	const trackFound = trackHits.some((track) => titleSim(query.title, track.trackTitle) >= TRACK_MATCH_THRESHOLD);
	const trackCount = trackCountScore(query.totalTracks, hit.packageTrack);
	const score = 0.5 * album + 0.3 * artist + 0.12 * (trackFound ? 1 : 0) + 0.08 * trackCount;
	const isAccepted =
		(album >= 0.75 && artist >= ARTIST_MATCH_THRESHOLD && score >= 0.72) || (album >= 0.9 && trackFound);
	return {
		key: keyOf(hit),
		artistName: hit.artistName,
		packageTitle: hit.packageTitle,
		mediaFormatNo: hit.mediaFormatNo,
		album,
		artist,
		trackFound,
		trackCount,
		score,
		isAccepted,
	};
}

// Used when no package matches the album, e.g. a compilation titled differently on mora.
function pickByTrack(query: MoraQuery, tracks: MoraTrackHit[]): MoraTrackHit | undefined {
	return tracks
		.filter((track) => track.mediaFormatNo !== VIDEO_FORMAT)
		.map((track) => ({
			track,
			title: titleSim(query.title, track.trackTitle),
			artist: artistScore(query, track),
			album: titleSim(query.album, track.packageTitle),
		}))
		.filter(({ title, artist }) => title >= TRACK_MATCH_THRESHOLD && artist >= ARTIST_MATCH_THRESHOLD)
		.toSorted(
			(a, b) =>
				0.6 * b.title + 0.4 * b.artist - (0.6 * a.title + 0.4 * a.artist) ||
				b.album - a.album ||
				a.track.startDate.localeCompare(b.track.startDate),
		)[0]?.track;
}

function toEdition(query: MoraQuery, { hit, trackHits }: Candidate): Edition | undefined {
	if (!LABEL_CODE_RE.test(hit.labelCode) || !PACKAGE_ID_RE.test(hit.packageId)) return undefined;
	const track = trackHits.find((t) => titleSim(query.title, t.trackTitle) >= TRACK_MATCH_THRESHOLD);
	const url = new URL(`https://mora.jp/package/${hit.labelCode}/${hit.packageId}/`);
	if (track) url.searchParams.set("trackMaterialNo", String(track.materialNo));
	return {
		url: url.toString(),
		labelCode: hit.labelCode,
		packageId: hit.packageId,
		packageTitle: hit.packageTitle,
		artistName: hit.artistName,
		mediaFormatNo: hit.mediaFormatNo,
		samplingFreq: hit.samplingFreq,
		bitPerSample: hit.bitPerSample,
		packageTrack: hit.packageTrack,
		startDate: hit.startDate,
		trackMaterialNo: track?.materialNo ?? null,
	};
}

function formatRank(mediaFormatNo: number): number {
	const index = FORMAT_ORDER.indexOf(mediaFormatNo);
	return index === -1 ? FORMAT_ORDER.length : index;
}

export function searchPageUrl(keyWord: string): string {
	return `https://mora.jp/search/top?${new URLSearchParams({ keyWord })}`;
}

export async function resolveMora(query: MoraQuery, search: MoraSearch): Promise<MoraResolution> {
	const debug: MatchDebug = { queries: [], candidates: [] };
	const artist = query.artists[0] ?? query.albumArtists[0] ?? "";
	const albumKeyword = keywordTitle(query.album);
	const titleKeyword = keywordTitle(query.title);

	const [packages, tracks] = await Promise.all([
		searchWithFallback((k) => search.packages(k), query, artist, albumKeyword, debug, "packages"),
		searchWithFallback((k) => search.tracks(k), query, artist, titleKeyword, debug, "tracks"),
	]);

	const candidates = new Map<string, Candidate>();
	for (const hit of packages) addCandidate(candidates, hit);
	for (const track of tracks) addCandidate(candidates, track, track);

	debug.candidates = [...candidates.values()]
		.map((candidate) => scoreCandidate(query, candidate))
		.toSorted((a, b) => b.score - a.score);

	const accepted = debug.candidates
		.filter((candidate) => candidate.isAccepted)
		.map((scored) => ({ scored, candidate: candidates.get(scored.key)! }))
		.toSorted(
			(a, b) =>
				b.scored.score - a.scored.score || a.candidate.hit.startDate.localeCompare(b.candidate.hit.startDate),
		);
	const winner = accepted[0]?.candidate.hit ?? pickByTrack(query, tracks);
	if (!winner) return { kind: "search", url: searchPageUrl(`${artist} ${titleKeyword}`.trim()), debug };

	const siblingsKeyword = `${winner.artistName} ${winner.packageTitle}`;
	debug.queries.push(`packages: ${siblingsKeyword}`);
	for (const hit of await search.packages(siblingsKeyword)) addCandidate(candidates, hit);

	const group = editionGroupOf(winner);
	const editions = [...candidates.values()]
		.filter((candidate) => editionGroupOf(candidate.hit) === group)
		.map((candidate) => toEdition(query, candidate))
		.filter((edition) => edition !== undefined)
		.toSorted(
			(a, b) => formatRank(a.mediaFormatNo) - formatRank(b.mediaFormatNo) || a.startDate.localeCompare(b.startDate),
		);
	if (editions.length === 0) return { kind: "search", url: searchPageUrl(`${artist} ${titleKeyword}`.trim()), debug };
	return { kind: "editions", editions, debug };
}
