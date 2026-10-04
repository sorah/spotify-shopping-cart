import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { probeCompanion } from "../companion.ts";
import { pairCompanion, unpairCompanion, useCompanionPairing } from "../hooks/useCompanion.ts";
import { CompanionStatusLine } from "./CompanionStatusLine.tsx";

type Props = {
	className: string;
	children: ReactNode;
};

export function CompanionSettingsButton({ className, children }: Props) {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<>
			<button type="button" className={className} onClick={() => setIsOpen(true)}>
				{children}
			</button>
			<CompanionDialog isOpen={isOpen} onClose={() => setIsOpen(false)} />
		</>
	);
}

type ProbeState = "probing" | "reachable" | "unreachable";

function PairingProbe() {
	const [state, setState] = useState<ProbeState>("probing");
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let isCurrent = true;
		setState("probing");
		void probeCompanion().then((isReachable) => {
			if (isCurrent) setState(isReachable ? "reachable" : "unreachable");
		});
		return () => {
			isCurrent = false;
		};
	}, [attempt]);

	return (
		<p className="companion-hint" role="status">
			{state === "probing" && "Asking the companion for a pairing token…"}
			{state === "reachable" && "The companion printed a pairing token in its console window. Copy it here."}
			{state === "unreachable" && (
				<>
					Can't reach the companion. Start it on this computer and allow local network access if the browser asks,
					then{" "}
					<button type="button" className="link-button" onClick={() => setAttempt((n) => n + 1)}>
						try again
					</button>
					.
				</>
			)}
		</p>
	);
}

function CompanionDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	// The footer and the playlist page can each render this dialog.
	const id = useId();
	const pairing = useCompanionPairing();
	const [token, setToken] = useState("");

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (isOpen && !dialog.open) dialog.showModal();
		if (!isOpen && dialog.open) dialog.close();
	}, [isOpen]);

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		pairCompanion(token.trim());
		setToken("");
	};

	return (
		<dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
			<h2 id={`${id}-title`}>Local library companion</h2>
			<p>
				The companion runs on the computer with your music library and finds the songs you already own. Paste the
				pairing token shown in its console window.
			</p>
			{/* Mounted only while open, so the home page never prompts for local network access. */}
			{isOpen && pairing && <CompanionStatusLine />}
			<form className="companion-form" onSubmit={onSubmit}>
				<label htmlFor={`${id}-token`}>{pairing ? "Replace the pairing token" : "Pairing token"}</label>
				<input
					id={`${id}-token`}
					type="text"
					autoComplete="off"
					spellCheck={false}
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				{isOpen && !pairing && <PairingProbe />}
				<div className="dialog-actions">
					{pairing && (
						<button type="button" className="button button-quiet companion-unpair" onClick={unpairCompanion}>
							Unpair
						</button>
					)}
					<button type="button" className="button button-quiet" onClick={onClose}>
						Close
					</button>
					<button type="submit" className="button button-primary" disabled={token.trim() === ""}>
						Pair
					</button>
				</div>
			</form>
		</dialog>
	);
}
