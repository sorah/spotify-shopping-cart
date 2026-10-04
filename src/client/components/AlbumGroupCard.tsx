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
	const albumArtists = joinArtists(group.album.artists);
	const purchasableUris = group.tracks.filter((track) => !track.isLocal).map((track) => track.uri);
	const isGroupPurchased =
		purchasableUris.length > 0 &&
		group.tracks.every((track) => track.isLocal || isPurchased(purchased, track));
	// The mora link opens the album page, so every song from that album is marked at once.
	const markGroup = () => markTracksPurchased(purchasableUris);

	return (
		<article className="album" data-purchased={isGroupPurchased || undefined}>
			<header className="album-header">
				{group.album.imageUrl ? (
					<img className="album-cover" src={group.album.imageUrl} alt="" loading="lazy" width={64} height={64} />
				) : (
					<div className="album-cover album-cover-empty" aria-hidden="true" />
				)}
				<div className="album-info">
					<h2 className="album-name">{group.album.name || "Unknown album"}</h2>
					<p className="album-meta">
						{albumArtists}
						{group.album.totalTracks !== null && <> · {pluralize(group.album.totalTracks, "track")}</>}
						{group.latestAddedAt && <> · added {formatDate(group.latestAddedAt)}</>}
					</p>
				</div>
				{purchasableUris.length > 0 &&
					(isGroupPurchased ? (
						<div className="album-status">
							<span className="badge-purchased">Purchased</span>
							<button
								type="button"
								className="button button-quiet"
								onClick={() => unmarkTracksPurchased(purchasableUris)}
							>
								Undo
							</button>
						</div>
					) : (
						<button type="button" className="button button-quiet album-mark" onClick={markGroup}>
							Mark purchased
						</button>
					))}
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
		</article>
	);
}
