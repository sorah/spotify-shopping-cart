import { seal } from "../../src/worker/cookieCrypto.ts";
import type { Session } from "../../src/worker/session.ts";
import { TEST_ENV } from "./env.ts";

export function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
	const cookies = new Map<string, { value: string; attributes: string }>();
	for (const header of response.headers.getSetCookie()) {
		const [pair, ...attributes] = header.split("; ");
		const index = pair!.indexOf("=");
		cookies.set(pair!.slice(0, index), {
			value: decodeURIComponent(pair!.slice(index + 1)),
			attributes: attributes.join("; "),
		});
	}
	return cookies;
}

export function cookieHeader(cookies: Record<string, string>): string {
	return Object.entries(cookies)
		.map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
		.join("; ");
}

export async function sessionCookie(session: Session): Promise<string> {
	return cookieHeader({ "__Host-ssc_session": await seal(TEST_ENV.COOKIE_ENCRYPTION_KEY, "session", session) });
}
