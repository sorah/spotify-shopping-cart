import { Link } from "react-router";

export default function NotFoundPage() {
	return (
		<section className="notice">
			<p>This page doesn't exist.</p>
			<Link to="/">Back to start</Link>
		</section>
	);
}
