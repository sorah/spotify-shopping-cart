import { describe, expect, test } from "bun:test";
import { artistSim, baseKey, dice, fullKey, keywordTitle, titleSim } from "../../../src/worker/mora/normalize.ts";
import { looseRomaji, romanizeKana } from "../../../src/worker/mora/romanize.ts";

describe("title keys", () => {
	test.each([
		["STRAY SHEEP (Deluxe Edition)", "stray sheep deluxe edition", "stray sheep"],
		["Lemon - Single", "lemon single", "lemon"],
		["うっせぇわ (Giga Remix)", "うっせぇわ giga remix", "うっせぇわ giga remix"],
		["Song (feat. Someone)", "song", "song"],
		["アルバム [ハイレゾ 96kHz/24bit]", "アルバム", "アルバム"],
		["Lemon 〜ドラマ「アンナチュラル」主題歌〜", "lemon ドラマ アンナチュラル 主題歌", "lemon"],
		["Ｆｕｌｌｗｉｄｔｈ・タイトル", "fullwidth タイトル", "fullwidth タイトル"],
		["(Remastered)", "remastered", "remastered"],
	])("%p", (title, full, base) => {
		expect(fullKey(title)).toBe(full);
		expect(baseKey(title)).toBe(base);
	});

	test("keywordTitle keeps the original text without qualifiers", () => {
		expect(keywordTitle("STRAY SHEEP (Deluxe Edition)")).toBe("STRAY SHEEP");
		expect(keywordTitle("Lemon - Single")).toBe("Lemon");
		expect(keywordTitle("うっせぇわ (Giga Remix)")).toBe("うっせぇわ Giga Remix");
	});
});

describe("similarity", () => {
	test("dice", () => {
		expect(dice("night", "nacht")).toBeCloseTo(0.25);
		expect(dice("a", "a")).toBe(1);
		expect(dice("a", "b")).toBe(0);
		expect(dice("", "")).toBe(0);
	});

	test("titleSim prefers exact keys over base keys", () => {
		expect(titleSim("Lemon", "Lemon")).toBe(1);
		expect(titleSim("STRAY SHEEP (Deluxe Edition)", "STRAY SHEEP")).toBe(0.92);
		expect(titleSim("うっせぇわ", "うっせぇわ (Giga Remix)")).toBeLessThan(0.75);
		expect(titleSim("Lemon", "STRAY SHEEP")).toBe(0);
	});

	test.each([
		[["米津玄師"], "米津玄師", "ヨネヅケンシ", 1],
		[["Ado"], "Ado", "アド", 1],
		[["YOASOBI", "Someone"], "YOASOBI", null, 1],
		[["Various Artists"], "V.A.", null, 1],
		[["Someone"], "Someone feat. Other", null, 0.95],
		[["Other"], "Someone & Other", null, 0.95],
	] as const)("artistSim(%p, %p) = %p", (names, mora, kana, expected) => {
		expect(artistSim([...names], mora, kana)).toBe(expected);
	});

	test("artistSim reads romanized names through kana", () => {
		expect(artistSim(["Kenshi Yonezu"], "米津玄師", "ヨネヅケンシ")).toBeGreaterThan(0.8);
		expect(artistSim(["Kenshi Yonezu"], "米津玄師", null)).toBe(0);
		expect(artistSim(["Taylor Swift"], "米津玄師", "ヨネヅケンシ")).toBeLessThan(0.3);
	});
});

describe("romanizeKana", () => {
	test.each([
		["ヨネヅケンシ", "yonezukenshi"],
		["キョウ", "kyou"],
		["マッチャ", "matcha"],
		["ガッコウ", "gakkou"],
		["ラーメン", "ramen"],
		["ひらがな", "hiragana"],
		["ファンタジー", "fantaji"],
	])("%p -> %p", (kana, romaji) => {
		expect(romanizeKana(kana)).toBe(romaji);
	});

	test("looseRomaji folds long vowels and syllabic n", () => {
		expect(looseRomaji("Yuuki Ohno")).toBe(looseRomaji("Yuki Ono"));
		expect(looseRomaji("Shimbashi")).toBe(looseRomaji("Shinbashi"));
		expect(looseRomaji("Kyou")).toBe("kyo");
	});
});
