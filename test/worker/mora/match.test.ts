import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { moraSearch } from "../../../src/worker/mora/client.ts";
import { type MoraResolution, resolveMora } from "../../../src/worker/mora/match.ts";
import { MORA_CASES } from "../../fixtures/mora/cases.ts";
import { replayMoraFixtures } from "../../fixtures/mora/replay.ts";

let requests: Request[];
beforeEach(async () => {
	requests = await replayMoraFixtures();
});
afterEach(() => mock.restore());

function editionsOf(resolution: MoraResolution) {
	if (resolution.kind !== "editions") throw new Error(`expected editions, got ${resolution.kind}`);
	return resolution.editions.map((edition) => [edition.mediaFormatNo, edition.url]);
}

const LEMON_SINGLE = [
	[10, "https://mora.jp/package/43000087/SRCL09749B00Z/?trackMaterialNo=11467222"],
	[15, "https://mora.jp/package/43000188/SRCL09749B00Z/?trackMaterialNo=30195061"],
	[12, "https://mora.jp/package/43000100/SRCL09749B00Z_48/?trackMaterialNo=21286729"],
];

const STRAY_SHEEP = [
	[10, "https://mora.jp/package/43000087/SECL02598B00Z/?trackMaterialNo=16545209"],
	[15, "https://mora.jp/package/43000188/SECL02598B00Z/?trackMaterialNo=30327857"],
	[12, "https://mora.jp/package/43000100/SEXX02051B00Z_48/?trackMaterialNo=16546072"],
];

describe("resolveMora", () => {
	test("offers every edition of a single, in AAC, lossless, hi-res order", async () => {
		expect(editionsOf(await resolveMora(MORA_CASES.lemonSingle, moraSearch))).toEqual(LEMON_SINGLE);
	});

	test("picks the album over the single carrying the same track", async () => {
		expect(editionsOf(await resolveMora(MORA_CASES.lemonOnStraySheep, moraSearch))).toEqual(STRAY_SHEEP);
	});

	test("ignores edition qualifiers mora does not use", async () => {
		const resolution = await resolveMora(MORA_CASES.deluxeQualifier, moraSearch);
		expect(editionsOf(resolution)).toEqual(STRAY_SHEEP);
		expect(resolution.debug.queries[0]).toBe("packages: 米津玄師 STRAY SHEEP");
	});

	test("matches a romanized artist through the kana reading", async () => {
		const resolution = await resolveMora(MORA_CASES.romanizedArtistAlbum, moraSearch);
		expect(editionsOf(resolution)).toEqual(STRAY_SHEEP.map(([format, url]) => [format, String(url).split("?")[0]]));
		expect(resolution.debug.queries).toContain("packages: STRAY SHEEP");
	});

	test("retries without a romanized artist for singles too", async () => {
		const resolution = await resolveMora(MORA_CASES.romanizedArtistSingle, moraSearch);
		expect(editionsOf(resolution)).toEqual(LEMON_SINGLE.map(([format, url]) => [format, String(url).split("?")[0]]));
	});

	test("keeps remixes and lyric videos out of the editions", async () => {
		expect(editionsOf(await resolveMora(MORA_CASES.remixSibling, moraSearch))).toEqual([
			[10, "https://mora.jp/package/43000006/00602435205861/?trackMaterialNo=16949245"],
			[15, "https://mora.jp/package/43000006/00602435205861_L/?trackMaterialNo=25593812"],
			[12, "https://mora.jp/package/43000006/00602438561094/?trackMaterialNo=18876342"],
		]);
	});

	test("ignores covers and translated releases", async () => {
		expect(editionsOf(await resolveMora(MORA_CASES.coversAround, moraSearch))).toEqual([
			[10, "https://mora.jp/package/43000011/4580789539947/?trackMaterialNo=23673125"],
			[15, "https://mora.jp/package/43000011/4580789539947_LL/?trackMaterialNo=37010244"],
			[12, "https://mora.jp/package/43000011/4580789539947_HD/?trackMaterialNo=23673089"],
		]);
	});

	test("falls back to the track search when the album title differs on mora", async () => {
		const resolution = await resolveMora(MORA_CASES.albumTitledDifferently, moraSearch);
		expect(editionsOf(resolution)).toEqual([
			[10, "https://mora.jp/package/43000006/00602478008511/?trackMaterialNo=38506857"],
			[15, "https://mora.jp/package/43000006/00602478008511_L/"],
			[12, "https://mora.jp/package/43000006/00602478008528/?trackMaterialNo=38506904"],
		]);
		expect(resolution.debug.queries.at(-1)).toBe("packages: Ado Adoのベストアドバム");
	});

	test("sends the user to mora search when nothing matches", async () => {
		const resolution = await resolveMora(MORA_CASES.unknown, moraSearch);
		expect(resolution).toMatchObject({
			kind: "search",
			url: "https://mora.jp/search/top?keyWord=Nobody+Qwxz+Nonexistent+Song+Zzyzx",
		});
	});

	test("stays within five subrequests", async () => {
		for (const query of Object.values(MORA_CASES)) {
			requests.length = 0;
			await resolveMora(query, moraSearch);
			expect(requests.length).toBeLessThanOrEqual(5);
		}
	});
});
