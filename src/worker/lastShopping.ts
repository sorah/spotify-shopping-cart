import { decodeBase64Url, encodeBase64Url } from "hono/utils/encode";
import type { LastShopping } from "../shared/types.ts";

// Spotify clients cap playlist descriptions at 300 characters.
export const MAX_DESCRIPTION_LENGTH = 300;

const DATA_VERSION = 1;
const TOKEN_RE = /\[ssc:([A-Za-z0-9_-]+)\]/g;
// Also matches a token whose summary was edited away in a Spotify client.
const BLOCK_RE = /\s*(?:Last shopping:[^[\]]*)?\[ssc:[A-Za-z0-9_-]*\]/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

type EmbeddedData = { v: typeof DATA_VERSION } & LastShopping;

export function parseLastShopping(description: string | null): LastShopping | null {
	const token = [...(description ?? "").matchAll(TOKEN_RE)].at(-1)?.[1];
	if (!token) return null;

	let data: Partial<EmbeddedData> | null;
	try {
		data = JSON.parse(new TextDecoder().decode(decodeBase64Url(token))) as Partial<EmbeddedData> | null;
	} catch {
		return null;
	}
	if (
		data?.v !== DATA_VERSION ||
		typeof data.at !== "string" ||
		Number.isNaN(Date.parse(data.at)) ||
		typeof data.songCount !== "number" ||
		!Number.isSafeInteger(data.songCount) ||
		data.songCount < 0
	) {
		return null;
	}
	return { at: data.at, songCount: data.songCount };
}

// Replaces any previous record while keeping the rest of the description, truncated to fit if needed.
export function formatDescription(current: string | null, lastShopping: LastShopping, timeZone: string): string {
	const data: EmbeddedData = { v: DATA_VERSION, ...lastShopping };
	const token = encodeBase64Url(new TextEncoder().encode(JSON.stringify(data)).buffer).replace(/=+$/, "");
	const songs = lastShopping.songCount === 1 ? "1 song" : `${lastShopping.songCount} songs`;
	const block = `Last shopping: ${formatLocalDate(lastShopping.at, timeZone)} (${songs}) [ssc:${token}]`;

	const text = decodeHtmlEntities(current ?? "").replace(BLOCK_RE, "").trim();
	if (!text) return block;
	return `${truncate(text, MAX_DESCRIPTION_LENGTH - block.length - 1)} ${block}`;
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch (error) {
		if (error instanceof RangeError) return false;
		throw error;
	}
}

function formatLocalDate(iso: string, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(iso));
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

// Spotify returns descriptions HTML-escaped, so they must be unescaped before being written back.
function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
		(match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
			if (name) return NAMED_ENTITIES[name.toLowerCase()]!;
			const codePoint = hex ? Number.parseInt(hex, 16) : Number(dec);
			return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
		},
	);
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	let result = "";
	for (const char of text) {
		if (result.length + char.length >= maxLength) break;
		result += char;
	}
	return `${result.trimEnd()}…`;
}
