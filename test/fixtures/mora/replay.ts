import { mockFetch } from "../../helpers/fetchMock.ts";

export type MoraFixtures = Record<string, unknown>;

export function fixtureKey(url: URL): string {
	return `${url.searchParams.get("searchKind")} ${url.searchParams.get("keyWord")}`;
}

export async function replayMoraFixtures(): Promise<Request[]> {
	const fixtures = (await Bun.file(new URL("./responses.json", import.meta.url)).json()) as MoraFixtures;
	return mockFetch((request) => {
		const key = fixtureKey(new URL(request.url));
		const fixture = fixtures[key];
		if (!fixture) throw new Error(`no mora fixture for "${key}"; run bun test/fixtures/mora/record.ts`);
		return new Response(JSON.stringify(fixture), { headers: { "Content-Type": "text/html;charset=utf-8" } });
	});
}
