import { useState } from "react";
import { restoreTracksPurchased, unmarkTracksPurchased } from "../hooks/usePurchased.ts";
import { joinArtists, pluralize } from "../lib/format.ts";
import type { AlbumGroup } from "../lib/grouping.ts";
import type { PurchasedMap } from "../lib/purchasedStore.ts";

type Props = {
	groups: AlbumGroup[];
	canEdit: boolean;
	onRemove: () => void;
};

export function PurchasedPanel({ groups, canEdit, onRemove }: Props) {
	const uris = groups.flatMap((group) => group.tracks.map((track) => track.uri));
	const count = uris.length;
	const [unmarked, setUnmarked] = useState<PurchasedMap>();
	// Undo is offered only until something is marked again.
	if (unmarked && count > 0) setUnmarked(undefined);

	return (
		<aside className="purchased" aria-labelledby="purchased-title">
			<div className="purchased-card">
				<h2 id="purchased-title" className="purchased-title">
					Purchased
				</h2>
				{groups.length === 0 ? (
					<p className="purchased-empty">Opening a song on mora marks its album as purchased.</p>
				) : (
					<ol className="purchased-albums">
						{groups.map((group) => {
							const albumName = group.album.name || "Unknown album";
							return (
								<li key={group.key} className="purchased-album">
									<div className="purchased-album-header">
										{group.album.imageUrl ? (
											<img
												className="purchased-cover"
												src={group.album.imageUrl}
												alt=""
												loading="lazy"
												width={40}
												height={40}
											/>
										) : (
											<div className="purchased-cover album-cover-empty" aria-hidden="true" />
										)}
										<div className="purchased-album-info">
											<span className="purchased-album-name">{albumName}</span>
											<span className="purchased-album-artists">{joinArtists(group.album.artists)}</span>
										</div>
										{group.tracks.length > 1 && (
											<button
												type="button"
												className="button button-quiet"
												aria-label={`Unmark all songs from ${albumName}`}
												onClick={() => unmarkTracksPurchased(group.tracks.map((track) => track.uri))}
											>
												Unmark all
											</button>
										)}
									</div>
									<ul className="purchased-tracks">
										{group.tracks.map((track) => (
											<li key={track.uri} className="purchased-track">
												<span className="purchased-track-name">{track.name}</span>
												<button
													type="button"
													className="button button-icon"
													title="Unmark as purchased"
													aria-label={`Unmark ${track.name}`}
													onClick={() => unmarkTracksPurchased([track.uri])}
												>
													×
												</button>
											</li>
										))}
									</ul>
								</li>
							);
						})}
					</ol>
				)}
			</div>
			{count > 0 ? (
				<div className="action-bar">
					<p>
						<strong>{pluralize(count, "song")}</strong> marked as purchased
					</p>
					<div className="action-bar-buttons">
						<button
							type="button"
							className="button button-quiet"
							onClick={() => setUnmarked(unmarkTracksPurchased(uris))}
						>
							Unmark all
						</button>
						<button
							type="button"
							className="button button-danger"
							disabled={!canEdit}
							title={canEdit ? undefined : "Only playlists you own or collaborate on can be edited"}
							onClick={onRemove}
						>
							Remove from playlist
						</button>
					</div>
				</div>
			) : (
				unmarked && (
					<div className="action-bar">
						<p>
							Unmarked <strong>{pluralize(Object.keys(unmarked).length, "song")}</strong>
						</p>
						<button
							type="button"
							className="button button-quiet"
							onClick={() => {
								restoreTracksPurchased(unmarked);
								setUnmarked(undefined);
							}}
						>
							Undo
						</button>
					</div>
				)
			)}
		</aside>
	);
}
