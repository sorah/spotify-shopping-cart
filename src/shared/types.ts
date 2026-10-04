export type ApiErrorCode =
	| "unauthenticated"
	| "reauth_required"
	| "cross_origin_request"
	| "not_found";

export type ApiError = {
	code: ApiErrorCode;
	message?: string;
};
