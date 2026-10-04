const DIGRAPHS: Record<string, string> = {
	キャ: "kya", キュ: "kyu", キョ: "kyo", キェ: "kye",
	ギャ: "gya", ギュ: "gyu", ギョ: "gyo",
	シャ: "sha", シュ: "shu", ショ: "sho", シェ: "she",
	ジャ: "ja", ジュ: "ju", ジョ: "jo", ジェ: "je",
	チャ: "cha", チュ: "chu", チョ: "cho", チェ: "che",
	ニャ: "nya", ニュ: "nyu", ニョ: "nyo",
	ヒャ: "hya", ヒュ: "hyu", ヒョ: "hyo",
	ビャ: "bya", ビュ: "byu", ビョ: "byo",
	ピャ: "pya", ピュ: "pyu", ピョ: "pyo",
	ミャ: "mya", ミュ: "myu", ミョ: "myo",
	リャ: "rya", リュ: "ryu", リョ: "ryo",
	ファ: "fa", フィ: "fi", フェ: "fe", フォ: "fo", フュ: "fyu",
	ティ: "ti", ディ: "di", デュ: "dyu", トゥ: "tu", ドゥ: "du",
	ウィ: "wi", ウェ: "we", ウォ: "wo",
	ヴァ: "va", ヴィ: "vi", ヴェ: "ve", ヴォ: "vo",
	ツァ: "tsa", ツィ: "tsi", ツェ: "tse", ツォ: "tso",
};

const MONOGRAPHS: Record<string, string> = {
	ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o",
	カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko",
	ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go",
	サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
	ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo",
	タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to",
	ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
	ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no",
	ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
	バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo",
	パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po",
	マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo",
	ヤ: "ya", ユ: "yu", ヨ: "yo",
	ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro",
	ワ: "wa", ヰ: "i", ヱ: "e", ヲ: "o", ン: "n", ヴ: "vu",
	ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o", ャ: "ya", ュ: "yu", ョ: "yo", ヮ: "wa",
};

function toKatakana(text: string): string {
	return text.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// Hepburn romanization of kana; anything else is passed through.
export function romanizeKana(text: string): string {
	const kana = toKatakana(text.normalize("NFKC"));
	let result = "";
	let geminate = false;
	for (let i = 0; i < kana.length; i++) {
		const ch = kana[i]!;
		if (ch === "ッ") {
			geminate = true;
			continue;
		}
		if (ch === "ー") continue;
		const pair = kana.slice(i, i + 2);
		let romaji = DIGRAPHS[pair];
		if (romaji) i++;
		else romaji = MONOGRAPHS[ch] ?? ch;
		if (geminate) {
			romaji = romaji.startsWith("ch") ? `t${romaji}` : romaji[0]! + romaji;
			geminate = false;
		}
		result += romaji;
	}
	return result;
}

// Folds spelling variants of romanized Japanese names, e.g. "Yuuki"/"Yuki", "Ohno"/"Ono", "Shimbashi"/"Shinbashi".
export function looseRomaji(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z]/g, "")
		.replace(/oh(?![aeiou])/g, "o")
		.replace(/ou|oo/g, "o")
		.replace(/uu/g, "u")
		.replace(/aa/g, "a")
		.replace(/ii/g, "i")
		.replace(/ee/g, "e")
		.replace(/m(?=[bmp])/g, "n");
}
