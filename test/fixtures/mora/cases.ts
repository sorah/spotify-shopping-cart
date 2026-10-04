import type { MoraQuery } from "../../../src/worker/mora/match.ts";

export const MORA_CASES = {
	lemonSingle: {
		title: "Lemon",
		artists: ["米津玄師"],
		album: "Lemon",
		albumArtists: ["米津玄師"],
		totalTracks: 3,
	},
	lemonOnStraySheep: {
		title: "Lemon",
		artists: ["米津玄師"],
		album: "STRAY SHEEP",
		albumArtists: ["米津玄師"],
		totalTracks: 15,
	},
	deluxeQualifier: {
		title: "Lemon",
		artists: ["米津玄師"],
		album: "STRAY SHEEP (Deluxe Edition)",
		albumArtists: ["米津玄師"],
		totalTracks: 15,
	},
	romanizedArtistAlbum: {
		title: "Lemon",
		artists: ["Kenshi Yonezu"],
		album: "STRAY SHEEP",
		albumArtists: ["Kenshi Yonezu"],
		totalTracks: 15,
	},
	romanizedArtistSingle: {
		title: "Lemon",
		artists: ["Kenshi Yonezu"],
		album: "Lemon",
		albumArtists: ["Kenshi Yonezu"],
		totalTracks: 3,
	},
	remixSibling: {
		title: "うっせぇわ",
		artists: ["Ado"],
		album: "うっせぇわ",
		albumArtists: ["Ado"],
		totalTracks: 1,
	},
	coversAround: {
		title: "アイドル",
		artists: ["YOASOBI"],
		album: "アイドル",
		albumArtists: ["YOASOBI"],
		totalTracks: 1,
	},
	albumTitledDifferently: {
		title: "うっせぇわ",
		artists: ["Ado"],
		album: "Ado's Best Adobum",
		albumArtists: ["Ado"],
		totalTracks: 40,
	},
	unknown: {
		title: "Nonexistent Song Zzyzx",
		artists: ["Nobody Qwxz"],
		album: "Nothing",
		albumArtists: ["Nobody Qwxz"],
		totalTracks: 1,
	},
} satisfies Record<string, MoraQuery>;
