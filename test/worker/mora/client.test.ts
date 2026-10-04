import { afterEach, describe, expect, mock, test } from "bun:test";
import { MoraError, moraSearch } from "../../../src/worker/mora/client.ts";
import { mockFetch } from "../../helpers/fetchMock.ts";

afterEach(() => mock.restore());

const section = (resultCode: string, list: unknown[] | null) => ({ resultCode, total: list?.length ?? 0, list });

describe("moraSearch", () => {
	test("queries getResult without forwarding browser headers", async () => {
		const requests = mockFetch(() => new Response(JSON.stringify({ data: { packageResult: section("SM0305000", []) } })));
		await moraSearch.packages("米津玄師 Lemon");
		const url = new URL(requests[0]!.url);
		expect(url.origin + url.pathname).toBe("https://mora.jp/search/getResult");
		expect(url.searchParams.get("keyWord")).toBe("米津玄師 Lemon");
		expect(url.searchParams.get("searchKind")).toBe("02");
		expect(requests[0]!.headers.has("Origin")).toBe(false);
		expect(requests[0]!.redirect).toBe("manual");
	});

	test("treats the no-hits result code as an empty list", async () => {
		mockFetch(() => new Response(JSON.stringify({ data: { trackResult: section("EM0305200", null) } })));
		expect(await moraSearch.tracks("nothing")).toEqual([]);
	});

	test("maps track hits to their package start date", async () => {
		mockFetch(
			() =>
				new Response(
					JSON.stringify({
						data: {
							trackResult: section("SM0305000", [
								{
									artistName: "A",
									artistNameKana: "エー",
									packageTitle: "P",
									packageId: "X1",
									labelCode: 43000001,
									mediaFormatNo: 10,
									samplingFreq: 44100,
									bitPerSample: null,
									packageTrack: null,
									startDate: "2020/01/02 00:00:00",
									packageStartDate: "2020/01/01 00:00:00",
									materialNo: 1,
									trackTitle: "T",
								},
							]),
						},
					}),
				),
		);
		expect(await moraSearch.tracks("A T")).toEqual([
			{
				labelCode: "43000001",
				packageId: "X1",
				artistName: "A",
				artistNameKana: "エー",
				packageTitle: "P",
				mediaFormatNo: 10,
				samplingFreq: 44100,
				bitPerSample: null,
				packageTrack: null,
				startDate: "2020/01/01 00:00:00",
				materialNo: 1,
				trackTitle: "T",
			},
		]);
	});

	test("rejects redirects to mora's error pages", async () => {
		mockFetch(() => new Response(null, { status: 302, headers: { Location: "https://mora.jp/unsupported" } }));
		await expect(moraSearch.packages("x")).rejects.toThrow(MoraError);
	});

	test("rejects failure result codes", async () => {
		mockFetch(() => new Response(JSON.stringify({ data: { packageResult: section("EM9999999", null) } })));
		await expect(moraSearch.packages("x")).rejects.toThrow(MoraError);
	});
});
