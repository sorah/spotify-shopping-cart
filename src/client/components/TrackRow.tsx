import type { PlaylistTrack } from "../../shared/types.ts";
import type { LocalMatchView } from "../lib/companionMatch.ts";
import { formatDate, joinArtists } from "../lib/format.ts";
import { moraRedirectUrl } from "../lib/mora.ts";
import { LocalMatchNote } from "./LocalMatchNote.tsx";

type Props = {
	track: PlaylistTrack;
	shouldShowArtists: boolean;
	isPurchased: boolean;
	localMatch: LocalMatchView | null;
	canLinkMora: boolean;
	onOpenMora: () => void;
};

export function TrackRow({ track, shouldShowArtists, isPurchased, localMatch, canLinkMora, onOpenMora }: Props) {
	return (
		<li className="track" data-purchased={isPurchased || undefined}>
			<div className="track-main">
				<span className="track-name">
					{isPurchased && (
						<span className="track-check" role="img" aria-label="Purchased">
							✓
						</span>
					)}
					{track.name}
				</span>
				{shouldShowArtists && <span className="track-artists">{joinArtists(track.artists)}</span>}
				{localMatch && <LocalMatchNote track={track} view={localMatch} canLinkMora={canLinkMora} />}
			</div>
			<time className="track-added" dateTime={track.addedAt ?? undefined}>
				{formatDate(track.addedAt)}
			</time>
			{track.isLocal ? (
				<span className="track-local">Local file</span>
			) : (
				<a
					className="button button-mora"
					href={moraRedirectUrl(track)}
					target="_blank"
					rel="noopener"
					onClick={onOpenMora}
					onAuxClick={(event) => event.button === 1 && onOpenMora()}
				>
					mora ↗
				</a>
			)}
		</li>
	);
}
