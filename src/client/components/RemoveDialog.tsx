import { useEffect, useRef } from "react";
import { pluralize } from "../lib/format.ts";

type Props = {
	isOpen: boolean;
	count: number;
	playlistName: string;
	isRequesting: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
};

export function RemoveDialog({ isOpen, count, playlistName, isRequesting, error, onConfirm, onClose }: Props) {
	const ref = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (isOpen && !dialog.open) dialog.showModal();
		if (!isOpen && dialog.open) dialog.close();
	}, [isOpen]);

	return (
		<dialog
			ref={ref}
			className="dialog"
			aria-labelledby="remove-dialog-title"
			onClose={onClose}
			onCancel={(event) => isRequesting && event.preventDefault()}
		>
			<h2 id="remove-dialog-title">Remove {pluralize(count, "purchased song")}?</h2>
			<p>
				They will be removed from “{playlistName}” on Spotify. If a song appears more than once, every copy is
				removed.
			</p>
			{error && (
				<p className="field-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions">
				<button type="button" className="button button-quiet" onClick={onClose} disabled={isRequesting}>
					Cancel
				</button>
				<button type="button" className="button button-danger" onClick={onConfirm} disabled={isRequesting}>
					{isRequesting ? "Removing…" : "Remove"}
				</button>
			</div>
		</dialog>
	);
}
