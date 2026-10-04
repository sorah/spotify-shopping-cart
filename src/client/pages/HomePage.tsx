import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiRequestError, loginUrl } from "../api.ts";
import { ApiErrorNotice } from "../components/ApiErrorNotice.tsx";
import { useMe } from "../hooks/useMe.ts";
import { parsePlaylistInput } from "../lib/playlistUrl.ts";

const AUTH_ERRORS: Record<string, string> = {
	access_denied: "Spotify login was cancelled.",
	state_mismatch: "The login attempt expired. Please try again.",
	token_exchange_failed: "Spotify didn't accept the login. Please try again.",
};

export default function HomePage() {
	const { data: me, error, isLoading } = useMe();
	const [searchParams] = useSearchParams();
	const authError = searchParams.get("auth_error");

	return (
		<section className="home">
			<h1 className="home-title">Turn your Spotify shopping cart into mora purchases.</h1>
			<p className="home-lead">
				Load the playlist where you keep songs to buy, open each album on mora, then clear what you bought.
			</p>
			{authError && (
				<div className="notice" role="alert">
					<p>{AUTH_ERRORS[authError] ?? "Spotify login failed. Please try again."}</p>
				</div>
			)}
			{isLoading ? null : me ? (
				<PlaylistForm />
			) : error instanceof ApiRequestError && error.code === "unauthenticated" ? (
				<a className="button button-spotify button-large" href={loginUrl("/")}>
					Log in with Spotify
				</a>
			) : error ? (
				<ApiErrorNotice error={error} />
			) : null}
		</section>
	);
}

function PlaylistForm() {
	const navigate = useNavigate();
	const [input, setInput] = useState("");
	const [message, setMessage] = useState<string>();

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const parsed = parsePlaylistInput(input);
		if (parsed.kind === "error") {
			setMessage(parsed.message);
			return;
		}
		navigate(`/playlists/${parsed.id}`);
	};

	return (
		<form className="playlist-form" onSubmit={onSubmit}>
			<label htmlFor="playlist-url">Playlist link</label>
			<div className="playlist-form-row">
				<input
					id="playlist-url"
					type="text"
					inputMode="url"
					autoComplete="off"
					placeholder="https://open.spotify.com/playlist/…"
					value={input}
					onChange={(event) => {
						setInput(event.target.value);
						setMessage(undefined);
					}}
					aria-invalid={message ? true : undefined}
					aria-describedby={message ? "playlist-url-error" : undefined}
				/>
				<button type="submit" className="button button-primary" disabled={input.trim() === ""}>
					Open
				</button>
			</div>
			{message && (
				<p id="playlist-url-error" className="field-error">
					{message}
				</p>
			)}
		</form>
	);
}
