import type { ApiError, ApiErrorCode, GetPlaylistItemsResponse, PlaylistTrack } from "../shared/types.ts";

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode | undefined,
		readonly retryAfter: number | undefined,
		message?: string,
	) {
		super(message ?? `request failed with ${status}${code ? ` (${code})` : ""}`);
	}

	get isUnauthenticated(): boolean {
		return this.code === "unauthenticated" || this.code === "reauth_required";
	}
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (response.ok) return (await response.json()) as T;
	const body = (await response.json().catch(() => undefined)) as ApiError | undefined;
	const retryAfter = Number(response.headers.get("Retry-After")) || undefined;
	throw new ApiRequestError(response.status, body?.code, retryAfter, body?.message);
}

export async function fetchJson<T>(path: string): Promise<T> {
	return parseResponse<T>(await fetch(path, { headers: { Accept: "application/json" } }));
}

async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
	return parseResponse<T>(
		await fetch(path, {
			method,
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
	return sendJson<T>("POST", path, body);
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
	return sendJson<T>("PUT", path, body);
}

// Pages are fetched one request at a time so each stays within the worker's subrequest budget.
export async function fetchAllPlaylistItems(id: string): Promise<PlaylistTrack[]> {
	const items: PlaylistTrack[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const page: GetPlaylistItemsResponse = await fetchJson(`/api/playlists/${id}/items?offset=${offset}`);
		items.push(...page.items);
		offset = page.nextOffset;
	}
	return items;
}

export function loginUrl(returnTo: string): string {
	return `/auth/login?${new URLSearchParams({ return_to: returnTo })}`;
}
