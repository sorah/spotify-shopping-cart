import { looseRomaji, romanizeKana } from "./romanize.ts";

const BRACKETS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"<": ">",
	"【": "】",
	"〔": "〕",
	"〈": "〉",
	"《": "》",
	"~": "~",
};

const FORMAT_RE =
	/hi-?res|ハイレゾ|high[- ]?resolution|\d+(\.\d+)?\s*k?hz|\d+\s*bit|flac|lossless|ロスレス|dsd|dolby|atmos|spatial/i;
const FEAT_RE = /^(feat\.?|ft\.?|featuring|with)\s/i;
// Version, mix, remix and live qualifiers identify different recordings and are deliberately kept.
const EDITION_RE =
	/remaster(ed)?|deluxe|edition|expanded|anniversary|bonus tracks?|special|complete|standard|limited|通常盤|限定盤|初回|生産|デラックス|リマスター|^(single|ep|album)$/i;
const TIEUP_RE = /主題歌|挿入歌|イメージソング|テーマ|cm\s?ソング|タイアップ|オープニング|エンディング|^from\s/i;

type Title = {
	main: string;
	segments: string[];
};

function splitTitle(title: string): Title {
	const text = title.normalize("NFKC").replace(/〜/g, "~");
	let main = "";
	const segments: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const close = BRACKETS[ch];
		const end = close ? text.indexOf(close, i + 1) : -1;
		if (end > i) {
			segments.push(text.slice(i + 1, end));
			main += " ";
			i = end;
		} else {
			main += ch;
		}
	}
	const [head, ...tails] = main.split(/\s+-\s+/);
	return { main: head!, segments: [...segments, ...tails] };
}

function stripSegments(title: string, patterns: RegExp[]): string {
	const { main, segments } = splitTitle(title);
	const kept = segments.filter((segment) => !patterns.some((pattern) => pattern.test(segment.trim())));
	const result = [main, ...kept].join(" ").replace(/\s+/g, " ").trim();
	return result || title.normalize("NFKC").trim();
}

export function norm(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// Drops format and featuring annotations only.
export function fullKey(title: string): string {
	return norm(stripSegments(title, [FORMAT_RE, FEAT_RE]));
}

// Also drops edition and tie-up annotations.
export function baseKey(title: string): string {
	return norm(stripSegments(title, [FORMAT_RE, FEAT_RE, EDITION_RE, TIEUP_RE]));
}

// mora returns nothing when the keyword carries qualifiers such as "(Deluxe Edition)" or "- Single".
export function keywordTitle(title: string): string {
	return stripSegments(title, [FORMAT_RE, FEAT_RE, EDITION_RE, TIEUP_RE]);
}

function bigrams(text: string): Map<string, number> {
	const compact = text.replace(/\s+/g, "");
	const counts = new Map<string, number>();
	for (let i = 0; i < compact.length - 1; i++) {
		const gram = compact.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

export function dice(a: string, b: string): number {
	const compactA = a.replace(/\s+/g, "");
	const compactB = b.replace(/\s+/g, "");
	if (compactA.length < 2 || compactB.length < 2) return compactA === compactB && compactA !== "" ? 1 : 0;
	const gramsA = bigrams(compactA);
	const gramsB = bigrams(compactB);
	let overlap = 0;
	for (const [gram, count] of gramsA) overlap += Math.min(count, gramsB.get(gram) ?? 0);
	return (2 * overlap) / (compactA.length - 1 + (compactB.length - 1));
}

export function titleSim(a: string, b: string): number {
	const fullA = fullKey(a);
	const fullB = fullKey(b);
	if (fullA !== "" && fullA === fullB) return 1;
	const baseA = baseKey(a);
	const baseB = baseKey(b);
	if (baseA !== "" && baseA === baseB) return 0.92;
	return Math.max(dice(fullA, fullB), 0.9 * dice(baseA, baseB));
}

const VARIOUS_ARTISTS_RE = /^(various artists|v a|オムニバス|ヴァリアス アーティスト)$/;
const CREDIT_SEPARATOR_RE = /\s*(?:[,、&×/]|\s(?:feat\.?|ft\.?|with|and|x|vs\.?)\s)\s*/i;
const ASCII_RE = /^[\x20-\x7e]+$/;

export function artistSim(spotifyNames: string[], moraName: string, moraKana: string | null): number {
	const mora = norm(moraName);
	const moraParts = moraName.normalize("NFKC").split(CREDIT_SEPARATOR_RE).map(norm);
	const moraRomaji = moraKana ? looseRomaji(romanizeKana(moraKana)) : "";
	let best = 0;
	for (const name of spotifyNames) {
		const spotify = norm(name);
		if (spotify === "") continue;
		if (spotify === mora) return 1;
		if (VARIOUS_ARTISTS_RE.test(spotify) && VARIOUS_ARTISTS_RE.test(mora)) return 1;
		if (moraParts.includes(spotify)) best = Math.max(best, 0.95);
		best = Math.max(best, dice(spotify, mora));
		if (moraRomaji && ASCII_RE.test(name)) best = Math.max(best, 0.9 * dice(looseRomaji(name), moraRomaji));
	}
	return best;
}
