import type { Session } from "./session.ts";

export type Bindings = {
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
};

export type AppEnv = {
	Bindings: Bindings;
	Variables: {
		session: Session;
	};
};
