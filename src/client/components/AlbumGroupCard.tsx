import { markTracksPurchased, unmarkTracksPurchased } from "../hooks/usePurchased.ts";
import { localMatchView, type MatchCache } from "../lib/companionMatch.ts";
import { formatDate, joinArtists, pluralize } from "../lib/format.ts";
import type { AlbumGroup } from "../lib/grouping.ts";
import { isPurchased, type PurchasedMap } from "../lib/purchasedStore.ts";
import { TrackRow } from "./TrackRow.tsx";

type Props = {
	group: AlbumGroup;
	purchased: PurchasedMap;
	localMatches: MatchCache | null;
	canLinkMora: boolean;
};

export function AlbumGroupCard({ group, purchased, localMatches, canLinkMora }: Props) {
	const albumName = group.album.name || "Unknown album";
	const albumArtists = joinArtists(group.album.artists);
	const purchasableUris = group.tracks.filter((track) => !track.isLocal).map((track) => track.uri);
	const isGroupPurchased =
		purchasableUris.length > 0 &&
		group.tracks.every((track) => track.isLocal || isPurchased(purchased, track));
	// The mora link opens the album page, so every song from that album is marked at once.
	const markGroup = () => markTracksPurchased(purchasableUris);

	return (
		<article className="album" data-purchased={isGroupPurchased || undefined}>
			<div className="album-body">
				<header className="album-header">
					{group.album.imageUrl ? (
						<img className="album-cover" src={group.album.imageUrl} alt="" loading="lazy" width={64} height={64} />
					) : (
						<div className="album-cover album-cover-empty" aria-hidden="true" />
					)}
					<div className="album-info">
						<h2 className="album-name">{albumName}</h2>
						<p className="album-meta">
							{albumArtists}
							{group.album.totalTracks !== null && <> · {pluralize(group.album.totalTracks, "track")}</>}
							{group.latestAddedAt && <> · added {formatDate(group.latestAddedAt)}</>}
						</p>
					</div>
					{isGroupPurchased && <span className="badge-purchased">Purchased</span>}
				</header>
				<ol className="tracks">
					{group.tracks.map((track) => {
						const isTrackPurchased = !track.isLocal && isPurchased(purchased, track);
						return (
							<TrackRow
								key={`${track.uri}:${track.position}`}
								track={track}
								shouldShowArtists={joinArtists(track.artists) !== albumArtists}
								isPurchased={isTrackPurchased}
								localMatch={localMatches && localMatchView(localMatches, track, isTrackPurchased)}
								canLinkMora={canLinkMora}
								onOpenMora={markGroup}
							/>
						);
					})}
				</ol>
			</div>
			{purchasableUris.length > 0 &&
				(isGroupPurchased ? (
					<button
						type="button"
						className="album-action"
						title="Undo purchased"
						aria-label={`Unmark all songs from ${albumName}`}
						onClick={() => unmarkTracksPurchased(purchasableUris)}
					>
						↺
					</button>
				) : (
					<button
						type="button"
						className="album-action album-action-mark"
						title="Mark purchased"
						aria-label={`Mark all songs from ${albumName} purchased`}
						onClick={markGroup}
					>
						✓
					</button>
				))}
		</article>
	);
}
