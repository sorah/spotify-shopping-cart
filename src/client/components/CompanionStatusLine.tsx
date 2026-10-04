import { CompanionRequestError, CompanionUnreachableError } from "../companion.ts";
import { useCompanionStatus } from "../hooks/useCompanion.ts";
import { NoCommonProtocolError } from "../lib/companionMatch.ts";
import { type CompanionSource, isIndexing, negotiateProtocol } from "../lib/companionProtocol.ts";
import { formatCount } from "../lib/format.ts";

type Tone = "ready" | "busy" | "off" | "error";

const UPDATE_MESSAGE = "The companion and this app share no protocol version. Update whichever is older.";

export function companionErrorMessage(error: Error): string {
	if (error instanceof CompanionUnreachableError) {
		return "Can't reach the companion. Check that it's running and that this browser may access your local network.";
	}
	if (error instanceof NoCommonProtocolError) return UPDATE_MESSAGE;
	if (!(error instanceof CompanionRequestError)) return "Something went wrong while talking to the companion.";
	switch (error.code) {
		case "unpaired":
			return "The companion didn't accept the pairing token. Pair again with the token it printed.";
		case "origin_not_allowed":
			return `The companion doesn't accept requests from ${location.origin}.`;
		case "protocol_mismatch":
			return UPDATE_MESSAGE;
		case "indexing":
			return "The companion is still indexing your library. Try again when it's ready.";
		default:
			return `The companion returned an error: ${error.message}`;
	}
}

function describeSource(source: CompanionSource): string {
	switch (source.state) {
		case "indexing":
			return source.progress && source.progress.total > 0
				? `${source.label} indexing ${Math.floor((source.progress.done / source.progress.total) * 100)}%`
				: `${source.label} indexing…`;
		case "error":
			return `${source.label}: ${source.error ?? "error"}`;
		default:
			return `${source.label} ${formatCount(source.entries, "song")}`;
	}
}

function useDescription(): { tone: Tone; text: string } {
	const status = useCompanionStatus();
	if (status.error) {
		return {
			tone: status.error instanceof CompanionUnreachableError ? "off" : "error",
			text: companionErrorMessage(status.error),
		};
	}
	if (!status.data) return { tone: "busy", text: "Connecting to the companion…" };
	if (negotiateProtocol(status.data.protocols) === null) return { tone: "error", text: UPDATE_MESSAGE };
	const sources = status.data.sources;
	return {
		tone: isIndexing(status.data) ? "busy" : sources.some((source) => source.state === "error") ? "error" : "ready",
		text: sources.length > 0 ? sources.map(describeSource).join(" · ") : "No sources configured",
	};
}

export function CompanionStatusLine() {
	const { tone, text } = useDescription();
	return (
		<p className="companion-status" data-tone={tone} role="status">
			<span className="companion-dot" aria-hidden="true" />
			{text}
		</p>
	);
}
