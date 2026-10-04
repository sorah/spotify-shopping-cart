import { describe, expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url } from "hono/utils/encode";
import { InvalidCookieKeyError, seal, unseal } from "../../src/worker/cookieCrypto.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const NOW = Date.UTC(2026, 9, 5);

describe("seal/unseal", () => {
	test("round-trips data", async () => {
		const sealed = await seal(KEY, "session", { accessToken: "a", n: 1 }, NOW);
		expect(sealed).toStartWith("v1.");
		expect(await unseal<{ accessToken: string; n: number }>(KEY, "session", sealed, 60, NOW)).toEqual({
			accessToken: "a",
			n: 1,
		});
	});

	test("uses a fresh IV per seal", async () => {
		const a = await seal(KEY, "session", "x", NOW);
		const b = await seal(KEY, "session", "x", NOW);
		expect(a).not.toBe(b);
	});

	test("rejects a tampered ciphertext", async () => {
		const sealed = await seal(KEY, "session", { admin: false }, NOW);
		const [v, iv, ct] = sealed.split(".");
		const bytes = decodeBase64Url(ct!);
		bytes[0]! ^= 1;
		expect(await unseal(KEY, "session", `${v}.${iv}.${encodeBase64Url(bytes.buffer)}`, 60, NOW)).toBeUndefined();
	});

	test("rejects a value sealed for another purpose", async () => {
		const sealed = await seal(KEY, "oauth_state", { state: "s" }, NOW);
		expect(await unseal(KEY, "session", sealed, 60, NOW)).toBeUndefined();
	});

	test("rejects a value sealed with another key", async () => {
		const sealed = await seal(OTHER_KEY, "session", "x", NOW);
		expect(await unseal(KEY, "session", sealed, 60, NOW)).toBeUndefined();
	});

	test("rejects values older than maxAge", async () => {
		const sealed = await seal(KEY, "session", "x", NOW);
		expect(await unseal<string>(KEY, "session", sealed, 60, NOW + 60_000)).toBe("x");
		expect(await unseal(KEY, "session", sealed, 60, NOW + 61_000)).toBeUndefined();
	});

	test("rejects malformed input", async () => {
		for (const input of ["", "v1", "v1..", "v2.AAAA.AAAA", "v1.AAAA.AAAA", "v1.!!!.???", "v1.a.b.c"]) {
			expect(await unseal(KEY, "session", input, 60, NOW)).toBeUndefined();
		}
	});

	test("requires a 32-byte key", async () => {
		const shortKey = btoa("short");
		await expect(seal(shortKey, "session", "x")).rejects.toThrow(InvalidCookieKeyError);
	});
});
