// Regenerates tests/fixtures/normalize.json from the TypeScript normalizer the Rust port mirrors.
// Usage: bun companion/scripts/gen-normalize-fixtures.ts
import { artistSim, baseKey, dice, fullKey, norm, titleSim } from "../../src/worker/mora/normalize.ts";

type Corpus = {
	titles: string[];
	titleSim: [string, string][];
	dice: [string, string][];
	artistSim: [string[], string][];
};

const dir = `${import.meta.dir}/../tests/fixtures`;
const corpus = (await Bun.file(`${dir}/normalize-corpus.json`).json()) as Corpus;
const fixtures = {
	titles: corpus.titles.map((input) => ({ input, norm: norm(input), fullKey: fullKey(input), baseKey: baseKey(input) })),
	titleSim: corpus.titleSim.map(([a, b]) => ({ a, b, value: titleSim(a, b) })),
	dice: corpus.dice.map(([a, b]) => ({ a, b, value: dice(a, b) })),
	artistSim: corpus.artistSim.map(([names, local]) => ({ names, local, value: artistSim(names, local, null) })),
};
await Bun.write(`${dir}/normalize.json`, `${JSON.stringify(fixtures, null, "\t")}\n`);
