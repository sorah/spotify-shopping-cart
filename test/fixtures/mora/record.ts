// Re-records mora search responses used by the matcher tests: bun test/fixtures/mora/record.ts
import { moraSearch } from "../../../src/worker/mora/client.ts";
import { resolveMora } from "../../../src/worker/mora/match.ts";
import { MORA_CASES } from "./cases.ts";
import { fixtureKey, type MoraFixtures } from "./replay.ts";

const PACKAGE_FIELDS = [
	"artistName",
	"artistNameKana",
	"packageTitle",
	"packageId",
	"labelCode",
	"mediaFormatNo",
	"samplingFreq",
	"bitPerSample",
	"packageTrack",
	"startDate",
];
const TRACK_FIELDS = [...PACKAGE_FIELDS, "materialNo", "trackTitle", "packageStartDate"];

type Section = { resultCode: string; total: number; list: Record<string, unknown>[] | null };

function trimSection(section: Section, fields: string[]) {
	return {
		resultCode: section.resultCode,
		total: section.total,
		list: section.list?.map((item) => Object.fromEntries(fields.map((field) => [field, item[field]]))) ?? null,
	};
}

const fixtures: MoraFixtures = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : input);
	const response = await realFetch(input, init);
	const body = JSON.parse(await response.text()) as { data: { packageResult: Section; trackResult: Section } };
	const kind = url.searchParams.get("searchKind");
	const data =
		kind === "02"
			? { packageResult: trimSection(body.data.packageResult, PACKAGE_FIELDS) }
			: { trackResult: trimSection(body.data.trackResult, TRACK_FIELDS) };
	fixtures[fixtureKey(url)] = { data };
	return new Response(JSON.stringify({ data }), { status: response.status });
}) as typeof fetch;

for (const query of Object.values(MORA_CASES)) await resolveMora(query, moraSearch);

const sorted = Object.fromEntries(Object.entries(fixtures).toSorted(([a], [b]) => a.localeCompare(b)));
await Bun.write(new URL("./responses.json", import.meta.url), `${JSON.stringify(sorted, null, "\t")}\n`);
console.log(`recorded ${Object.keys(sorted).length} responses`);
