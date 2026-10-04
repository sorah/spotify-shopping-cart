import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../hooks/useMe.ts";
import { CompanionSettingsButton } from "./CompanionSettingsButton.tsx";
import { DebugExportButton } from "./DebugExportButton.tsx";

export function Layout({ children }: { children: ReactNode }) {
	const { data: me } = useMe();
	return (
		<>
			<header className="site-header">
				<Link to="/" className="brand">
					<span className="brand-mark" aria-hidden="true">
						♪
					</span>
					Shopping Cart
				</Link>
				{me && (
					<form method="post" action="/auth/logout" className="account">
						<span className="account-name">{me.displayName ?? me.id}</span>
						<button type="submit" className="button button-quiet">
							Log out
						</button>
					</form>
				)}
			</header>
			<main className="site-main">{children}</main>
			<footer className="site-footer">
				{me && <CompanionSettingsButton className="footer-link">Local library companion</CompanionSettingsButton>}
				<DebugExportButton />
			</footer>
		</>
	);
}
