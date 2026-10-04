const SEARCH_URL = "https://mora.jp/search/getResult";
const TIMEOUT_MS = 5000;
const NO_HITS = "EM0305200";

export type MoraPackageHit = {
	labelCode: string;
	packageId: string;
	artistName: string;
	artistNameKana: string | null;
	packageTitle: string;
	mediaFormatNo: number;
	samplingFreq: number | null;
	bitPerSample: string | null;
	// unknown for hits from track search
	packageTrack: number | null;
	startDate: string;
};

export type MoraTrackHit = MoraPackageHit & {
	materialNo: number;
	trackTitle: string;
};

export type MoraSearch = {
	packages(keyWord: string): Promise<MoraPackageHit[]>;
	tracks(keyWord: string): Promise<MoraTrackHit[]>;
};

type RawSection<T> = {
	resultCode: string;
	list: T[] | null;
};

type RawPackage = Omit<MoraPackageHit, "packageTrack"> & {
	packageTrack?: number | null;
};

type RawTrack = RawPackage & {
	materialNo: number;
	trackTitle: string;
	packageStartDate?: string;
};

type RawResult = {
	data?: {
		packageResult?: RawSection<RawPackage>;
		trackResult?: RawSection<RawTrack>;
	};
};

export class MoraError extends Error {}

// mora answers with a redirect to an error page instead of an error status, and rejects foreign Origin headers.
async function getResult(keyWord: string, searchKind: "02" | "03"): Promise<RawResult> {
	const url = `${SEARCH_URL}?${new URLSearchParams({ keyWord, searchKind })}`;
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (response.status !== 200) throw new MoraError(`mora search returned ${response.status}`);
	// Served as text/html despite being JSON.
	return JSON.parse(await response.text()) as RawResult;
}

function listOf<T>(section: RawSection<T> | undefined): T[] {
	if (!section) throw new MoraError("mora search response is missing its result section");
	if (!section.resultCode.startsWith("SM") && section.resultCode !== NO_HITS) {
		throw new MoraError(`mora search failed with ${section.resultCode}`);
	}
	return section.list ?? [];
}

function toPackageHit(raw: RawPackage): MoraPackageHit {
	return {
		labelCode: String(raw.labelCode),
		packageId: raw.packageId,
		artistName: raw.artistName,
		artistNameKana: raw.artistNameKana ?? null,
		packageTitle: raw.packageTitle,
		mediaFormatNo: raw.mediaFormatNo,
		samplingFreq: raw.samplingFreq ?? null,
		bitPerSample: raw.bitPerSample ?? null,
		packageTrack: raw.packageTrack ?? null,
		startDate: raw.startDate,
	};
}

export const moraSearch: MoraSearch = {
	async packages(keyWord) {
		const result = await getResult(keyWord, "02");
		return listOf(result.data?.packageResult).map(toPackageHit);
	},
	async tracks(keyWord) {
		const result = await getResult(keyWord, "03");
		return listOf(result.data?.trackResult).map((raw) => ({
			...toPackageHit(raw),
			packageTrack: null,
			startDate: raw.packageStartDate ?? raw.startDate,
			materialNo: raw.materialNo,
			trackTitle: raw.trackTitle,
		}));
	},
};
