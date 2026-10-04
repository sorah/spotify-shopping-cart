//! HTTP API (protocol v1). Handlers see only [`crate::state::AppState`]: the index and status,
//! never paths or the cache, so no response can carry a local path.

// 500 real tracks are about 300 KB.
const BODY_LIMIT: usize = 2 * 1024 * 1024;

pub fn router(state: std::sync::Arc<crate::state::AppState>) -> axum::Router {
    axum::Router::new()
        .route("/v1/status", axum::routing::get(status))
        .route("/v1/match", axum::routing::post(match_tracks))
        .fallback(not_found)
        .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

pub async fn serve(
    state: std::sync::Arc<crate::state::AppState>,
    listen: std::net::SocketAddr,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> crate::error::Result<()> {
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|source| crate::error::Error::Io {
            context: format!("listening on {listen}"),
            source,
        })?;
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|source| crate::error::Error::Io {
            context: "serving HTTP".to_owned(),
            source,
        })
}

fn error_response(
    status: axum::http::StatusCode,
    code: &'static str,
    message: Option<String>,
) -> axum::response::Response {
    let body = crate::protocol::ErrorBody {
        protocol: crate::protocol::PROTOCOL_VERSION,
        code,
        message,
    };
    axum::response::IntoResponse::into_response((status, axum::Json(body)))
}

/// The header's value, or `None` when it is missing, repeated or not visible ASCII.
fn header(headers: &axum::http::HeaderMap, name: axum::http::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).into_iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

/// Host check (DNS rebinding), origin allowlist, CORS and the pairing token, in that order.
/// A rejected host or origin gets no CORS headers; every other response from an allowed origin
/// carries them, including errors.
async fn guard(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let headers = request.headers();
    if header(headers, axum::http::header::HOST) != Some(state.host.as_str()) {
        return error_response(
            axum::http::StatusCode::FORBIDDEN,
            "origin_not_allowed",
            None,
        );
    }
    let Some(origin) = header(headers, axum::http::header::ORIGIN)
        .filter(|origin| {
            state
                .allowed_origins
                .iter()
                .any(|allowed| allowed == origin)
        })
        .map(str::to_owned)
    else {
        return error_response(
            axum::http::StatusCode::FORBIDDEN,
            "origin_not_allowed",
            None,
        );
    };

    if request.method() == axum::http::Method::OPTIONS {
        let private_network = headers
            .get("access-control-request-private-network")
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"true"));
        let mut response =
            axum::response::IntoResponse::into_response(axum::http::StatusCode::NO_CONTENT);
        let out = response.headers_mut();
        add_cors(out, &origin);
        out.insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
            axum::http::HeaderValue::from_static("GET, POST"),
        );
        out.insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
            axum::http::HeaderValue::from_static("Authorization, Content-Type"),
        );
        out.insert(
            axum::http::header::ACCESS_CONTROL_MAX_AGE,
            axum::http::HeaderValue::from_static("600"),
        );
        if private_network {
            out.insert(
                "access-control-allow-private-network",
                axum::http::HeaderValue::from_static("true"),
            );
        }
        return response;
    }

    let authorized = header(headers, axum::http::header::AUTHORIZATION)
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .is_some_and(|(_, token)| crate::secret::token_matches(&state.token, token.trim()));
    let mut response = if authorized {
        next.run(request).await
    } else {
        state.pairing_requested(&origin);
        error_response(axum::http::StatusCode::UNAUTHORIZED, "unpaired", None)
    };
    add_cors(response.headers_mut(), &origin);
    response
}

fn add_cors(headers: &mut axum::http::HeaderMap, origin: &str) {
    if let Ok(value) = axum::http::HeaderValue::from_str(origin) {
        headers.insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.append(
        axum::http::header::VARY,
        axum::http::HeaderValue::from_static("Origin"),
    );
}

async fn status(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
) -> axum::Json<crate::protocol::CompanionStatus> {
    axum::Json(state.status())
}

async fn match_tracks(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    body: Result<axum::body::Bytes, axum::extract::rejection::BytesRejection>,
) -> axum::response::Response {
    let too_many = || {
        error_response(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_tracks",
            Some(format!(
                "send at most {} tracks per request",
                crate::protocol::MAX_TRACKS
            )),
        )
    };
    let body = match body {
        Ok(body) => body,
        Err(rejection) if rejection.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
            return too_many();
        }
        Err(rejection) => {
            return error_response(
                axum::http::StatusCode::BAD_REQUEST,
                "bad_request",
                Some(rejection.body_text()),
            );
        }
    };
    let bad_request = |e: serde_json::Error| {
        error_response(
            axum::http::StatusCode::BAD_REQUEST,
            "bad_request",
            Some(e.to_string()),
        )
    };
    let probe: crate::protocol::ProtocolProbe = match serde_json::from_slice(&body) {
        Ok(probe) => probe,
        Err(e) => return bad_request(e),
    };
    if probe.protocol != Some(crate::protocol::PROTOCOL_VERSION) {
        return error_response(
            axum::http::StatusCode::CONFLICT,
            "protocol_mismatch",
            Some(format!(
                "supported protocols: {:?}",
                crate::protocol::SUPPORTED_PROTOCOLS
            )),
        );
    }
    let request: crate::protocol::MatchRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(e) => return bad_request(e),
    };
    if request.tracks.len() > crate::protocol::MAX_TRACKS {
        return too_many();
    }
    let Some(index) = state.index() else {
        return error_response(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "indexing",
            None,
        );
    };
    let library_revision = index.revision.clone();
    let permit = state
        .match_permits
        .clone()
        .acquire_owned()
        .await
        .expect("the semaphore is never closed");
    let results = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::matcher::match_tracks(&index, &request.tracks)
    })
    .await
    {
        Ok(results) => results,
        Err(e) => {
            tracing::error!(error = %e, "matching failed");
            return error_response(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                None,
            );
        }
    };
    axum::response::IntoResponse::into_response(axum::Json(crate::protocol::MatchResponse {
        protocol: crate::protocol::PROTOCOL_VERSION,
        library_revision,
        results,
    }))
}

async fn not_found() -> axum::response::Response {
    error_response(axum::http::StatusCode::NOT_FOUND, "not_found", None)
}
