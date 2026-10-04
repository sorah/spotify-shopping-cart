import { BrowserRouter, Route, Routes } from "react-router";
import { SWRConfig, type SWRConfiguration } from "swr";
import { ApiRequestError, fetchJson } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import HomePage from "./pages/HomePage.tsx";
import NotFoundPage from "./pages/NotFoundPage.tsx";
import PlaylistPage from "./pages/PlaylistPage.tsx";

const SWR_CONFIG: SWRConfiguration = {
	fetcher: fetchJson,
	revalidateOnFocus: false,
	errorRetryCount: 2,
	shouldRetryOnError: (error) => !(error instanceof ApiRequestError) || error.status >= 500,
};

export function App() {
	return (
		<SWRConfig value={SWR_CONFIG}>
			<BrowserRouter>
				<Layout>
					<Routes>
						<Route path="/" element={<HomePage />} />
						<Route path="/playlists/:id" element={<PlaylistPage />} />
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</Layout>
			</BrowserRouter>
		</SWRConfig>
	);
}
