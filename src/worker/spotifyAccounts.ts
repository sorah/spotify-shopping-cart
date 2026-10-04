const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export const SCOPES = [
	"playlist-read-private",
	"playlist-read-collaborative",
	"playlist-modify-public",
	"playlist-modify-private",
];

export type ClientCredentials = {
	clientId: string;
	clientSecret: string;
};

export type TokenSet = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

type TokenResponse = {
	access_token: string;
	token_type: string;
	scope: string;
	expires_in: number;
	refresh_token?: string;
};

export class SpotifyTokenError extends Error {
	constructor(
		readonly status: number,
		readonly error: string | undefined,
	) {
		super(`Spotify token endpoint returned ${status}${error ? ` (${error})` : ""}`);
	}

	get isInvalidGrant(): boolean {
		return this.error === "invalid_grant";
	}
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES.join(" "),
		state,
	}).toString();
	return url.toString();
}

export async function exchangeCode(
	credentials: ClientCredentials,
	code: string,
	redirectUri: string,
): Promise<TokenSet> {
	const token = await requestToken(credentials, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
	});
	if (!token.refresh_token) throw new SpotifyTokenError(200, "missing_refresh_token");
	return toTokenSet(token, token.refresh_token);
}

export async function refreshAccessToken(
	credentials: ClientCredentials,
	refreshToken: string,
): Promise<TokenSet> {
	const token = await requestToken(credentials, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	// Spotify does not always rotate the refresh token.
	return toTokenSet(token, token.refresh_token ?? refreshToken);
}

async function requestToken(
	{ clientId, clientSecret }: ClientCredentials,
	params: Record<string, string>,
): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(params),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
		throw new SpotifyTokenError(response.status, body?.error);
	}
	return (await response.json()) as TokenResponse;
}

function toTokenSet(token: TokenResponse, refreshToken: string): TokenSet {
	return {
		accessToken: token.access_token,
		refreshToken,
		expiresAt: Date.now() + token.expires_in * 1000,
	};
}
