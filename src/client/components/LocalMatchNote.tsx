import type { PlaylistTrack } from "../../shared/types.ts";
import { dismissLocalMatch } from "../hooks/useCompanion.ts";
import { markTracksPurchased, unmarkTracksPurchased } from "../hooks/usePurchased.ts";
import { type LocalMatchView, moraPackageUrl } from "../lib/companionMatch.ts";
import type { LocalMatch, MatchedBy } from "../lib/companionProtocol.ts";
import { formatDurationDifference, joinArtists } from "../lib/format.ts";

type Props = {
	track: PlaylistTrack;
	view: LocalMatchView;
	canLinkMora: boolean;
};

const MATCHED_BY_LABELS: Record<MatchedBy, string> = {
	isrc: "same ISRC",
	"store-id": "same store ID",
	metadata: "similar names",
};

const OWNERSHIP_LABELS: Record<LocalMatch["ownership"], string> = {
	purchased: "purchased",
	matched: "iTunes Match",
	imported: "imported",
	flat: "folder file",
	"apple-music": "Apple Music",
};

function describeMatch(match: LocalMatch, matchedBy: MatchedBy | null): string {
	const delta = match.signals.durationDeltaMs;
	return [
		match.location,
		OWNERSHIP_LABELS[match.ownership] ?? match.ownership,
		match.format,
		match.cloudOnly && "cloud only",
		delta !== null && (Math.abs(delta) < 100 ? "same length" : `length ${formatDurationDifference(delta)} off`),
		matchedBy && (MATCHED_BY_LABELS[matchedBy] ?? matchedBy),
	]
		.filter(Boolean)
		.join(" · ");
}

export function LocalMatchNote({ track, view, canLinkMora }: Props) {
	if (view.kind === "owned") {
		const { match } = view;
		return (
			<span className="local-match" data-kind="owned">
				<span className="local-badge" data-kind="owned" title={match?.location}>
					In your library
				</span>
				{match && (
					<button
						type="button"
						className="link-button local-match-dismiss"
						aria-label={`Dismiss the library match for ${track.name}`}
						onClick={() => {
							dismissLocalMatch(track.uri, match.id);
							unmarkTracksPurchased([track.uri]);
						}}
					>
						Not this one
					</button>
				)}
			</span>
		);
	}

	const { match } = view;
	const moraUrl = canLinkMora ? moraPackageUrl(match) : null;
	return (
		<div className="local-match" data-kind="review">
			<p className="local-match-title">
				<span className="local-badge" data-kind="review">
					Maybe in your library
				</span>{" "}
				{match.title} — {joinArtists(match.artists)}
			</p>
			<p className="local-match-detail">
				{describeMatch(match, view.matchedBy)}
				{moraUrl && (
					<>
						{" · "}
						<a href={moraUrl} target="_blank" rel="noopener">
							mora ↗
						</a>
					</>
				)}
			</p>
			<div className="local-match-actions">
				<button
					type="button"
					className="button button-quiet button-small"
					aria-label={`Mark ${track.name} purchased`}
					onClick={() => markTracksPurchased([track.uri])}
				>
					Mark purchased
				</button>
				<button
					type="button"
					className="button button-quiet button-small"
					aria-label={`Dismiss the library match for ${track.name}`}
					onClick={() => dismissLocalMatch(track.uri, match.id)}
				>
					Not this one
				</button>
			</div>
		</div>
	);
}
