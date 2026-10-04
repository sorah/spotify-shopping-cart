import { useSWRConfig } from "swr";
import { buildDebugExport, debugExportFilename } from "../lib/debugExport.ts";

// Revoking right after click() can cancel the download in browsers that read the blob asynchronously.
const REVOKE_DELAY_MS = 60_000;

export function DebugExportButton() {
	const { cache } = useSWRConfig();

	const onClick = () => {
		const data = buildDebugExport({
			now: new Date(),
			url: location.href,
			userAgent: navigator.userAgent,
			storage: localStorage,
			cache,
		});
		const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, "\t")], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = debugExportFilename(data.exportedAt);
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
	};

	return (
		<button type="button" className="footer-link" onClick={onClick}>
			Export debug data
		</button>
	);
}
