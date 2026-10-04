import { useLocation } from "react-router";
import { ApiRequestError, loginUrl } from "../api.ts";

function messageFor(error: Error): string {
	if (!(error instanceof ApiRequestError)) return "Something went wrong. Check your connection and try again.";
	switch (error.code) {
		case "unauthenticated":
			return "Log in with Spotify to continue.";
		case "reauth_required":
			return "Your Spotify session has expired. Log in again to continue.";
		case "not_allowlisted":
			return "This Spotify account isn't allowed to use this app yet. Ask the app owner to add you in the Spotify Developer Dashboard.";
		case "playlist_forbidden":
			return "Spotify only lets this app open playlists you own or collaborate on.";
		case "rate_limited":
			return `Spotify is rate limiting requests. Try again${error.retryAfter ? ` in ${error.retryAfter} seconds` : " shortly"}.`;
		case "not_found":
			return "This playlist doesn't exist or isn't visible to you.";
		case "bad_request":
			return "That doesn't look like a valid playlist.";
		default:
			return "Spotify returned an error. Try again in a moment.";
	}
}

export function ApiErrorNotice({ error }: { error: Error }) {
	const location = useLocation();
	const isUnauthenticated = error instanceof ApiRequestError && error.isUnauthenticated;
	return (
		<div className="notice" role="alert">
			<p>{messageFor(error)}</p>
			{isUnauthenticated && (
				<a className="button button-spotify" href={loginUrl(location.pathname + location.search)}>
					Log in with Spotify
				</a>
			)}
		</div>
	);
}
