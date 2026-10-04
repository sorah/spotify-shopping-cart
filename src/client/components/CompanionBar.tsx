import { useRef } from "react";
import type { SWRResponse } from "swr";
import type { MatchSummary } from "../lib/companionMatch.ts";
import { type CompanionStatus, isIndexing, negotiateProtocol } from "../lib/companionProtocol.ts";
import { formatCount } from "../lib/format.ts";
import { CompanionSettingsButton } from "./CompanionSettingsButton.tsx";
import { CompanionStatusLine, companionErrorMessage } from "./CompanionStatusLine.tsx";

type Props = {
	status: SWRResponse<CompanionStatus, Error>;
	summary: MatchSummary | null;
	isChecking: boolean;
	checkError: Error | undefined;
	markedCount: number | undefined;
	onCheck: () => void;
};

export function CompanionBar({ status, summary, isChecking, checkError, markedCount, onCheck }: Props) {
	const reviewIndex = useRef(0);
	// Review notes are spread across the album list, so each click cycles to the next one.
	const scrollToNextReview = () => {
		const notes = document.querySelectorAll(".local-match[data-kind='review']");
		const note = notes[reviewIndex.current++ % notes.length];
		note?.closest(".track")?.scrollIntoView({ behavior: "smooth", block: "center" });
	};
	// A failed status still allows a check, which doubles as a retry.
	const isBlocked =
		status.data !== undefined && (isIndexing(status.data) || negotiateProtocol(status.data.protocols) === null);

	return (
		<section className="companion" aria-labelledby="companion-title">
			<div className="companion-main">
				<h2 id="companion-title" className="companion-title">
					Local library
				</h2>
				<CompanionStatusLine />
				{summary && summary.checked > 0 && (
					<p className="companion-summary">
						Found {summary.owned} owned,{" "}
						{summary.toReview > 0 ? (
							<button type="button" className="link-button" onClick={scrollToNextReview}>
								{summary.toReview} to review
							</button>
						) : (
							"none to review"
						)}{" "}
						in {formatCount(summary.checked, "song")}.
						{markedCount !== undefined && markedCount > 0 && (
							<> Marked {formatCount(markedCount, "song")} as purchased.</>
						)}
					</p>
				)}
				{checkError && (
					<p className="field-error" role="alert">
						{companionErrorMessage(checkError)}
					</p>
				)}
			</div>
			<div className="companion-actions">
				<CompanionSettingsButton className="button button-quiet">Settings</CompanionSettingsButton>
				<button type="button" className="button button-primary" disabled={isChecking || isBlocked} onClick={onCheck}>
					{isChecking ? "Checking…" : "Check local library"}
				</button>
			</div>
		</section>
	);
}
