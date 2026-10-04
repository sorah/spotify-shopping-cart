import { spyOn } from "bun:test";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

// Restore with mock.restore() in afterEach.
export function mockFetch(handler: FetchHandler): Request[] {
	const requests: Request[] = [];
	const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		requests.push(request.clone());
		return handler(request);
	};
	spyOn(globalThis, "fetch").mockImplementation(fakeFetch as typeof fetch);
	return requests;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, init);
}
