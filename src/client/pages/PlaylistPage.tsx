import { useMemo } from "react";
import { useParams } from "react-router";
import useSWR from "swr";
import type { GetPlaylistResponse, PlaylistTrack } from "../../shared/types.ts";
import { type ApiRequestError, fetchAllPlaylistItems } from "../api.ts";
import { AlbumGroupCard } from "../components/AlbumGroupCard.tsx";
import { ApiErrorNotice } from "../components/ApiErrorNotice.tsx";
import { useMe } from "../hooks/useMe.ts";
import { pluralize } from "../lib/format.ts";
import { groupByAlbum } from "../lib/grouping.ts";

export default function PlaylistPage() {
	const { id = "" } = useParams();
	// Waiting for /api/me lets a single request refresh an expired token before the others start.
	const { data: me, error: meError } = useMe();
	const playlist = useSWR<GetPlaylistResponse, ApiRequestError>(me ? `/api/playlists/${id}` : null);
	const items = useSWR<PlaylistTrack[], ApiRequestError>(me ? ["playlist-items", id] : null, () =>
		fetchAllPlaylistItems(id),
	);
	const groups = useMemo(() => (items.data ? groupByAlbum(items.data) : []), [items.data]);

	const error = meError ?? playlist.error ?? items.error;
	if (error) return <ApiErrorNotice error={error} />;

	return (
		<section className="playlist">
			<header className="playlist-header">
				{playlist.data?.imageUrl ? (
					<img className="playlist-cover" src={playlist.data.imageUrl} alt="" width={96} height={96} />
				) : (
					<div className="playlist-cover album-cover-empty" aria-hidden="true" />
				)}
				<div className="playlist-info">
					<p className="playlist-kicker">Playlist</p>
					<h1 className="playlist-name">{playlist.data?.name ?? "Loading…"}</h1>
					{playlist.data && (
						<p className="playlist-meta">
							by {playlist.data.ownerName ?? playlist.data.ownerId}
							{items.data && (
								<>
									{" "}
									· {pluralize(items.data.length, "song")} · {pluralize(groups.length, "album")}
								</>
							)}
							{" · "}
							<a href={playlist.data.externalUrl} target="_blank" rel="noopener">
								Open in Spotify
							</a>
						</p>
					)}
				</div>
			</header>

			{items.isLoading || !items.data ? (
				<p className="loading">Loading songs…</p>
			) : groups.length === 0 ? (
				<p className="empty">This playlist is empty. Nothing left to buy!</p>
			) : (
				<div className="albums">
					{groups.map((group) => (
						<AlbumGroupCard key={group.key} group={group} />
					))}
				</div>
			)}
		</section>
	);
}
