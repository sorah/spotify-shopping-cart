import type { Bindings } from "./env.ts";

// Bindings is hand-written so tests can compile without the generated Env; keep it in sync with cloudflare.config.ts.
type Assert<T extends true> = T;
export type EnvSatisfiesBindings = Assert<Env extends Bindings ? true : false>;
