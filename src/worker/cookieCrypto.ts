import { decodeBase64, decodeBase64Url, encodeBase64Url } from "hono/utils/encode";

export type SealPurpose = "session" | "oauth_state";

type Envelope<T> = {
	iat: number;
	data: T;
};

const VERSION = "v1";
const IV_LENGTH = 12;

const keyCache = new Map<string, Promise<CryptoKey>>();

export class InvalidCookieKeyError extends Error {}

function importKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		const raw = decodeBase64(secret);
		if (raw.byteLength !== 32) {
			throw new InvalidCookieKeyError("COOKIE_ENCRYPTION_KEY must be 32 bytes encoded in base64");
		}
		key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
		keyCache.set(secret, key);
	}
	return key;
}

export async function seal<T>(
	secret: string,
	purpose: SealPurpose,
	data: T,
	now: number = Date.now(),
): Promise<string> {
	const key = await importKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const envelope: Envelope<T> = { iat: Math.floor(now / 1000), data };
	const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
		key,
		plaintext,
	);
	return `${VERSION}.${encodeBase64Url(iv.buffer)}.${encodeBase64Url(ciphertext)}`;
}

// Returns undefined for anything that fails to authenticate, parse, or is older than maxAgeSeconds.
export async function unseal<T>(
	secret: string,
	purpose: SealPurpose,
	sealed: string,
	maxAgeSeconds: number,
	now: number = Date.now(),
): Promise<T | undefined> {
	const key = await importKey(secret);
	const [version, ivPart, ciphertextPart, ...rest] = sealed.split(".");
	if (version !== VERSION || !ivPart || !ciphertextPart || rest.length > 0) return undefined;

	let envelope: Envelope<T>;
	try {
		const iv = decodeBase64Url(ivPart);
		if (iv.byteLength !== IV_LENGTH) return undefined;
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
			key,
			decodeBase64Url(ciphertextPart),
		);
		envelope = JSON.parse(new TextDecoder().decode(plaintext));
	} catch {
		return undefined;
	}

	const age = Math.floor(now / 1000) - envelope.iat;
	if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds) return undefined;
	return envelope.data;
}
