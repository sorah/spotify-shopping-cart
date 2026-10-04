import type { AlbumGroup } from "../lib/grouping.ts";
import { formatDate, joinArtists, pluralize } from "../lib/format.ts";
import { TrackRow } from "./TrackRow.tsx";

export function AlbumGroupCard({ group }: { group: AlbumGroup }) {
	const albumArtists = joinArtists(group.album.artists);
	return (
		<article className="album">
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
			</header>
			<ol className="tracks">
				{group.tracks.map((track) => (
					<TrackRow
						key={`${track.uri}:${track.position}`}
						track={track}
						shouldShowArtists={joinArtists(track.artists) !== albumArtists}
					/>
				))}
			</ol>
		</article>
	);
}
