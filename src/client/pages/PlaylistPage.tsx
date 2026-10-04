import { useMemo, useState } from "react";
import { useParams } from "react-router";
import useSWR from "swr";
import type {
	GetPlaylistResponse,
	PlaylistTrack,
	PutLastShoppingRequest,
	PutLastShoppingResponse,
	RemovePlaylistItemsRequest,
	RemovePlaylistItemsResponse,
} from "../../shared/types.ts";
import { ApiRequestError, fetchAllPlaylistItems, postJson, putJson } from "../api.ts";
import { AlbumGroupCard } from "../components/AlbumGroupCard.tsx";
import { ApiErrorNotice } from "../components/ApiErrorNotice.tsx";
import { CompanionBar } from "../components/CompanionBar.tsx";
import { PurchasedPanel } from "../components/PurchasedPanel.tsx";
import { RemoveDialog } from "../components/RemoveDialog.tsx";
import { useCompanionMatches } from "../hooks/useCompanion.ts";
import { useMe } from "../hooks/useMe.ts";
import { unmarkTracksPurchased, usePurchased } from "../hooks/usePurchased.ts";
import { summarizeMatches } from "../lib/companionMatch.ts";
import { formatDate, pluralize } from "../lib/format.ts";
import { groupByAlbum } from "../lib/grouping.ts";
import { purchasedGroups } from "../lib/purchasedStore.ts";

// Matches the worker's per-request cap.
const REMOVE_BATCH_SIZE = 500;

export default function PlaylistPage() {
	const { id = "" } = useParams();
	// Waiting for /api/me lets a single request refresh an expired token before the others start.
	const { data: me, error: meError } = useMe();
	const playlist = useSWR<GetPlaylistResponse, ApiRequestError>(me ? `/api/playlists/${id}` : null);
	const items = useSWR<PlaylistTrack[], ApiRequestError>(me ? ["playlist-items", id] : null, () =>
		fetchAllPlaylistItems(id),
	);
	const purchased = usePurchased();
	const groups = useMemo(() => (items.data ? groupByAlbum(items.data) : []), [items.data]);
	const purchasedAlbums = useMemo(() => purchasedGroups(groups, purchased), [groups, purchased]);
	const purchasedUris = useMemo(
		() => purchasedAlbums.flatMap((group) => group.tracks.map((track) => track.uri)),
		[purchasedAlbums],
	);
	const companion = useCompanionMatches(items.data);
	const matchSummary = useMemo(
		() => (companion.matches && items.data ? summarizeMatches(companion.matches, items.data, purchased) : null),
		[companion.matches, items.data, purchased],
	);
	const canLinkMora = companion.status.data?.capabilities.includes("ids.mora") === true;

	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [isRequesting, setIsRequesting] = useState(false);
	const [removeError, setRemoveError] = useState<string>();

	const isOwner = me !== undefined && playlist.data !== undefined && playlist.data.ownerId === me.id;
	const canEdit = isOwner || playlist.data?.collaborative === true;

	const recordLastShopping = async (songCount: number) => {
		try {
			const lastShopping = await putJson<PutLastShoppingResponse>(`/api/playlists/${id}/last-shopping`, {
				songCount,
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			} satisfies PutLastShoppingRequest);
			await playlist.mutate((current) => current && { ...current, lastShopping }, { revalidate: false });
		} catch (error) {
			// The songs are already removed, so a stale description isn't worth an error message.
			console.error(error);
		}
	};

	const removePurchased = async () => {
		if (isRequesting) return;
		setIsRequesting(true);
		setRemoveError(undefined);
		const removed = new Set<string>();
		try {
			for (let i = 0; i < purchasedUris.length; i += REMOVE_BATCH_SIZE) {
				const uris = purchasedUris.slice(i, i + REMOVE_BATCH_SIZE);
				await postJson<RemovePlaylistItemsResponse>(`/api/playlists/${id}/remove`, {
					uris,
				} satisfies RemovePlaylistItemsRequest);
				for (const uri of uris) removed.add(uri);
				unmarkTracksPurchased(uris);
			}
			setIsDialogOpen(false);
		} catch (error) {
			console.error(error);
			setRemoveError(
				error instanceof ApiRequestError && error.code === "playlist_forbidden"
					? "Spotify only lets this app edit playlists you own or collaborate on."
					: "Some songs couldn't be removed. Try again.",
			);
		} finally {
			setIsRequesting(false);
			if (removed.size > 0) {
				await Promise.all([
					items.mutate((current) => current?.filter((track) => !removed.has(track.uri))),
					isOwner && recordLastShopping(removed.size),
				]);
			}
		}
	};

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
							{playlist.data.lastShopping && (
								<>
									{" · "}
									Last shopping{" "}
									<time dateTime={playlist.data.lastShopping.at}>
										{formatDate(playlist.data.lastShopping.at)}
									</time>{" "}
									({pluralize(playlist.data.lastShopping.songCount, "song")})
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

			{companion.isPaired && (
				<CompanionBar
					status={companion.status}
					summary={matchSummary}
					isChecking={companion.isChecking}
					checkError={companion.checkError}
					markedCount={companion.markedCount}
					onCheck={companion.check}
				/>
			)}

			{items.isLoading || !items.data ? (
				<p className="loading">Loading songs…</p>
			) : groups.length === 0 ? (
				<p className="empty">This playlist is empty. Nothing left to buy!</p>
			) : (
				<div className="playlist-body">
					<div className="albums">
						{groups.map((group) => (
							<AlbumGroupCard
								key={group.key}
								group={group}
								purchased={purchased}
								localMatches={companion.matches}
								canLinkMora={canLinkMora}
							/>
						))}
					</div>
					<PurchasedPanel
						groups={purchasedAlbums}
						canEdit={canEdit}
						onRemove={() => {
							setRemoveError(undefined);
							setIsDialogOpen(true);
						}}
					/>
				</div>
			)}

			<RemoveDialog
				isOpen={isDialogOpen}
				count={purchasedUris.length}
				playlistName={playlist.data?.name ?? ""}
				isRequesting={isRequesting}
				error={removeError}
				onConfirm={removePurchased}
				onClose={() => !isRequesting && setIsDialogOpen(false)}
			/>
		</section>
	);
}
