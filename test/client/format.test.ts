import { describe, expect, test } from "bun:test";
import { formatCount, formatDurationDifference } from "../../src/client/lib/format.ts";

describe("formatDurationDifference", () => {
	test("keeps tenths of a second below 10 seconds", () => {
		expect(formatDurationDifference(240)).toBe("0.2s");
		expect(formatDurationDifference(-1500)).toBe("1.5s");
		expect(formatDurationDifference(14_400)).toBe("14s");
		expect(formatDurationDifference(-65_000)).toBe("1:05");
	});
});

describe("formatCount", () => {
	test("groups digits and pluralizes", () => {
		expect(formatCount(1, "song")).toBe("1 song");
		expect(formatCount(23292, "song")).toBe(`${new Intl.NumberFormat().format(23292)} songs`);
	});
});
