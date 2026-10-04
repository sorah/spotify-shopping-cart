import type {
	CompanionErrorBody,
	CompanionErrorCode,
	CompanionStatus,
	CompanionTrack,
	MatchRequest,
	MatchResponse,
} from "./lib/companionProtocol.ts";

// Fixed because the production CSP lists it in connect-src.
export const COMPANION_ORIGIN = "http://127.0.0.1:47611";

// Also what a fetch rejected by the browser's local network access permission looks like.
export class CompanionUnreachableError extends Error {
	constructor(options?: ErrorOptions) {
		super("companion is unreachable", options);
	}
}

export class CompanionRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: CompanionErrorCode | undefined,
		message?: string,
	) {
		super(message ?? `companion request failed with ${status}${code ? ` (${code})` : ""}`);
	}
}

async function companionFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${COMPANION_ORIGIN}${path}`, {
			...init,
			cache: "no-store",
			headers: { ...init.headers, Accept: "application/json", Authorization: `Bearer ${token}` },
		});
	} catch (error) {
		throw new CompanionUnreachableError({ cause: error });
	}
	if (response.ok) return (await response.json()) as T;
	const body = (await response.json().catch(() => undefined)) as CompanionErrorBody | undefined;
	throw new CompanionRequestError(response.status, body?.code, body?.message);
}

// Sent without a token, so the companion prints its pairing token in its console. Resolves to whether it answered.
export async function probeCompanion(): Promise<boolean> {
	try {
		await fetch(`${COMPANION_ORIGIN}/v1/status`, { cache: "no-store" });
		return true;
	} catch {
		return false;
	}
}

export function fetchCompanionStatus(token: string): Promise<CompanionStatus> {
	return companionFetch(token, "/v1/status");
}

export function postCompanionMatch(token: string, protocol: number, tracks: CompanionTrack[]): Promise<MatchResponse> {
	return companionFetch(token, "/v1/match", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ protocol, tracks } satisfies MatchRequest),
	});
}
