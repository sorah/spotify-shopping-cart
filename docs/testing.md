# Testing

- **Layout:** `bun test` runs everything under `test/`. Tests never live next to source files, because the worker and client programs would pick up `bun:test`.
- **Helpers**
  - `test/helpers/fetchMock.ts`: `mockFetch(handler)` spies on the global `fetch` and returns the captured requests. Call `mock.restore()` in `afterEach`.
  - `test/helpers/cookies.ts`: builds sealed session cookies and parses `Set-Cookie` headers.
  - `test/helpers/env.ts`: test `Bindings` and the origin `https://app.test`.
- **Worker tests** call `app.request(...)` with `TEST_ENV` and a mocked `fetch`. They cover OAuth, sessions, CSRF, the API, the mora client and matcher, and the redirector.
- **mora fixtures**
  - `test/fixtures/mora/responses.json` holds real `getResult` responses, trimmed to the fields the code uses and keyed by `"<searchKind> <keyWord>"`.
  - `cases.ts` lists the Spotify-side queries.
  - `record.ts` runs the matcher against live mora and rewrites the fixtures: `bun test/fixtures/mora/record.ts`.
  - Re-record whenever the matcher's queries change. Replay fails with a clear message naming any missing key.
- **Client:** only the pure modules are unit-tested (grouping, URL parsing, mora links, the purchased store, the debug export). Components have no tests.
- **UI checks:** done manually with `playwright-cli` against the dev server, using `page.route` mocks for `/api/*` (and `context.route` for `/mora/redirect`, which opens in a new tab).
  - A debug export from the real app (see [client.md](client.md)) gives realistic `/api/*` bodies and purchased marks to mock with. Its items entry is the concatenation of all pages, so serve it as one `{ items, nextOffset: null, total }` page.
  - The user may have dropped exports into `tmp/spotify-shopping-cart-debug-*.json`. Look there before writing mock data by hand.
