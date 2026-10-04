import { describe, expect, test } from "bun:test";
import {
	formatDescription,
	isValidTimeZone,
	MAX_DESCRIPTION_LENGTH,
	parseLastShopping,
} from "../../src/worker/lastShopping.ts";

const SHOPPING = { at: "2026-10-05T16:30:00.000Z", songCount: 12 };

function token(data: unknown): string {
	return `[ssc:${btoa(JSON.stringify(data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}]`;
}

describe("formatDescription", () => {
	test("summarizes the shopping in the given time zone and embeds it as unpadded base64url", () => {
		const description = formatDescription(null, SHOPPING, "Asia/Tokyo");
		expect(description).toMatch(/^Last shopping: 2026-10-06 \(12 songs\) \[ssc:[A-Za-z0-9_-]+\]$/);
		expect(formatDescription(null, SHOPPING, "America/Los_Angeles")).toStartWith("Last shopping: 2026-10-05 ");
		expect(formatDescription(null, { ...SHOPPING, songCount: 1 }, "UTC")).toContain("(1 song)");
	});

	test("round-trips through parseLastShopping", () => {
		expect(parseLastShopping(formatDescription("Songs to buy", SHOPPING, "UTC"))).toEqual(SHOPPING);
	});

	test("keeps the owner's text and replaces the previous record", () => {
		const previous = formatDescription("Songs to buy", { at: "2026-09-01T00:00:00.000Z", songCount: 3 }, "UTC");
		const description = formatDescription(previous, SHOPPING, "UTC");
		expect(description).toStartWith("Songs to buy Last shopping: 2026-10-05 (12 songs) [ssc:");
		expect(description.match(/ssc:/g)).toHaveLength(1);
	});

	test("drops a token whose summary was edited away", () => {
		const description = formatDescription(`Songs to buy ${token({ v: 1, ...SHOPPING })}`, SHOPPING, "UTC");
		expect(description.match(/ssc:/g)).toHaveLength(1);
		expect(description).toStartWith("Songs to buy Last shopping:");
	});

	test("unescapes the HTML entities Spotify returns", () => {
		const description = formatDescription("Rock &amp; Roll &#x27;n&#39; &quot;pop&quot; &lt;3 &#x2F;", SHOPPING, "UTC");
		expect(description).toStartWith(`Rock & Roll 'n' "pop" <3 / Last shopping:`);
	});

	test("truncates the owner's text to fit Spotify's limit", () => {
		const description = formatDescription("あ".repeat(400), SHOPPING, "UTC");
		expect(description).toHaveLength(MAX_DESCRIPTION_LENGTH);
		expect(description).toMatch(/^あ+… Last shopping:/);
		expect(parseLastShopping(description)).toEqual(SHOPPING);
	});
});

describe("parseLastShopping", () => {
	test("returns null without a token", () => {
		expect(parseLastShopping(null)).toBeNull();
		expect(parseLastShopping("Songs to buy")).toBeNull();
	});

	test("reads the last token", () => {
		const latest = { at: "2026-10-05T00:00:00.000Z", songCount: 2 };
		expect(parseLastShopping(`${token({ v: 1, ...SHOPPING })} ${token({ v: 1, ...latest })}`)).toEqual(latest);
	});

	test.each([
		["[ssc:!!!]"],
		["[ssc:bm90IGpzb24]"],
		[token(null)],
		[token({ v: 2, ...SHOPPING })],
		[token({ v: 1, at: "yesterday", songCount: 1 })],
		[token({ v: 1, at: SHOPPING.at, songCount: 1.5 })],
		[token({ v: 1, at: SHOPPING.at })],
	])("ignores malformed tokens %#", (description) => {
		expect(parseLastShopping(description)).toBeNull();
	});
});

describe("isValidTimeZone", () => {
	test("accepts IANA names and rejects others", () => {
		expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
	});
});
