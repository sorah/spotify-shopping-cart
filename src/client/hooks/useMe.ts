import useSWR from "swr";
import type { GetMeResponse } from "../../shared/types.ts";
import type { ApiRequestError } from "../api.ts";

export function useMe() {
	return useSWR<GetMeResponse, ApiRequestError>("/api/me");
}
