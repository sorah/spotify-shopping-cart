import { useSyncExternalStore } from "react";

export type LocalStore<T> = {
	get: () => T;
	set: (value: T) => void;
	clear: () => void;
	use: () => T;
};

// A JSON value in localStorage that React components can subscribe to; shared across tabs through the storage event.
export function createLocalStore<T>(key: string, parse: (raw: string | null) => T): LocalStore<T> {
	const listeners = new Set<() => void>();
	let cachedRaw: string | null = null;
	let cachedValue = parse(null);

	const get = (): T => {
		const raw = localStorage.getItem(key);
		if (raw !== cachedRaw) {
			cachedRaw = raw;
			cachedValue = parse(raw);
		}
		return cachedValue;
	};

	const notify = () => {
		for (const listener of listeners) listener();
	};

	const onStorage = (event: StorageEvent) => {
		if (event.key === key || event.key === null) notify();
	};

	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		if (listeners.size === 1) window.addEventListener("storage", onStorage);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) window.removeEventListener("storage", onStorage);
		};
	};

	return {
		get,
		set: (value) => {
			localStorage.setItem(key, JSON.stringify(value));
			notify();
		},
		clear: () => {
			localStorage.removeItem(key);
			notify();
		},
		use: () => useSyncExternalStore(subscribe, get),
	};
}
