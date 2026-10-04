//! iTunes Lookup client: resolves store track IDs to the store's (content-language) names.
//! Only catalog IDs are sent.

pub const BATCH_SIZE: usize = 200;
const BACKOFF: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_ATTEMPTS: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct StoreTrack {
    pub track_id: u64,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub collection_name: Option<String>,
    pub collection_artist_name: Option<String>,
    pub collection_id: Option<u64>,
    pub track_time_millis: Option<i64>,
}

#[derive(serde::Deserialize)]
struct LookupResponse {
    #[serde(default)]
    results: Vec<LookupResult>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupResult {
    wrapper_type: Option<String>,
    track_id: Option<u64>,
    track_name: Option<String>,
    artist_name: Option<String>,
    collection_name: Option<String>,
    collection_artist_name: Option<String>,
    collection_id: Option<u64>,
    track_time_millis: Option<i64>,
}

pub struct LookupClient {
    http: reqwest::Client,
    base_url: String,
    country: String,
    interval: std::time::Duration,
    backoff: std::time::Duration,
    last_request: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

enum Outcome {
    Found(Vec<StoreTrack>),
    BadRequest,
}

impl LookupClient {
    pub fn new(country: &str, interval: std::time::Duration) -> crate::error::Result<Self> {
        if country.len() != 2 || !country.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(crate::error::Error::Config(format!(
                "itunesLookup.country must be a two-letter code, got {country:?}"
            )));
        }
        let http = reqwest::Client::builder()
            .user_agent(concat!("ssc-companion/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self {
            http,
            base_url: "https://itunes.apple.com".to_owned(),
            country: country.to_ascii_lowercase(),
            interval,
            backoff: BACKOFF,
            last_request: tokio::sync::Mutex::new(None),
        })
    }

    pub fn with_base_url(mut self, base_url: &str, backoff: std::time::Duration) -> Self {
        self.base_url = base_url.trim_end_matches('/').to_owned();
        self.backoff = backoff;
        self
    }

    pub fn country(&self) -> &str {
        &self.country
    }

    /// Resolves up to [`BATCH_SIZE`] IDs. IDs missing from the result are delisted. A 400 means
    /// one bad ID in the batch, so the batch is bisected until it is found and dropped.
    pub async fn lookup(&self, ids: &[u64]) -> crate::error::Result<Vec<StoreTrack>> {
        let mut found = Vec::new();
        let mut pending = vec![ids.to_vec()];
        while let Some(batch) = pending.pop() {
            if batch.is_empty() {
                continue;
            }
            match self.request(&batch).await? {
                Outcome::Found(tracks) => found.extend(tracks),
                Outcome::BadRequest if batch.len() > 1 => {
                    let (left, right) = batch.split_at(batch.len() / 2);
                    pending.push(right.to_vec());
                    pending.push(left.to_vec());
                }
                Outcome::BadRequest => {
                    tracing::debug!(id = batch[0], "iTunes Lookup rejected a store ID");
                }
            }
        }
        Ok(found)
    }

    async fn request(&self, ids: &[u64]) -> crate::error::Result<Outcome> {
        let csv = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let url = format!("{}/lookup?country={}&id={csv}", self.base_url, self.country);
        for attempt in 1..=MAX_ATTEMPTS {
            self.throttle().await;
            let response = self.http.get(&url).send().await?;
            let status = response.status();
            if status.is_success() {
                let body: LookupResponse = response.json().await?;
                return Ok(Outcome::Found(
                    body.results.into_iter().filter_map(convert).collect(),
                ));
            }
            if status == reqwest::StatusCode::BAD_REQUEST {
                return Ok(Outcome::BadRequest);
            }
            let retryable = status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error();
            if !retryable || attempt == MAX_ATTEMPTS {
                return Err(crate::error::Error::Lookup(format!("HTTP {status}")));
            }
            tracing::warn!(%status, "iTunes Lookup throttled; backing off");
            tokio::time::sleep(self.backoff).await;
        }
        unreachable!("the last attempt returns")
    }

    async fn throttle(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(previous) = *last {
            tokio::time::sleep_until(previous + self.interval).await;
        }
        *last = Some(tokio::time::Instant::now());
    }
}

fn convert(result: LookupResult) -> Option<StoreTrack> {
    if result.wrapper_type.as_deref() != Some("track") {
        return None;
    }
    Some(StoreTrack {
        track_id: result.track_id?,
        track_name: result.track_name,
        artist_name: result.artist_name,
        collection_name: result.collection_name,
        collection_artist_name: result.collection_artist_name,
        collection_id: result.collection_id,
        track_time_millis: result.track_time_millis,
    })
}

#[cfg(test)]
mod tests {
    async fn mock_lookup(
        axum::extract::Query(query): axum::extract::Query<
            std::collections::HashMap<String, String>,
        >,
    ) -> axum::response::Response {
        use axum::response::IntoResponse as _;
        assert_eq!(query.get("country").map(String::as_str), Some("jp"));
        let ids: Vec<u64> = query["id"]
            .split(',')
            .map(|id| id.parse().unwrap())
            .collect();
        if ids.contains(&666) {
            return axum::http::StatusCode::BAD_REQUEST.into_response();
        }
        let results: Vec<serde_json::Value> = ids
            .iter()
            .filter(|id| *id % 2 == 0)
            .map(|id| {
                serde_json::json!({
                    "wrapperType": "track",
                    "trackId": id,
                    "trackName": format!("曲{id}"),
                    "artistName": "歌手",
                    "collectionName": "アルバム",
                    "collectionId": 1000 + id,
                    "trackTimeMillis": 200000,
                })
            })
            .collect();
        axum::Json(serde_json::json!({ "resultCount": results.len(), "results": results }))
            .into_response()
    }

    #[tokio::test]
    async fn bisects_bad_ids_and_skips_delisted() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route("/lookup", axum::routing::get(mock_lookup));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = crate::lookup::LookupClient::new("JP", std::time::Duration::ZERO)
            .unwrap()
            .with_base_url(&format!("http://{addr}"), std::time::Duration::ZERO);
        let mut found = client.lookup(&[2, 3, 666, 4, 5, 6]).await.unwrap();
        found.sort_by_key(|t| t.track_id);
        let ids: Vec<u64> = found.iter().map(|t| t.track_id).collect();
        assert_eq!(ids, vec![2, 4, 6]);
        assert_eq!(found[0].track_name.as_deref(), Some("曲2"));
        assert_eq!(found[0].collection_id, Some(1002));
    }

    #[test]
    fn rejects_bad_country() {
        assert!(crate::lookup::LookupClient::new("j/p", std::time::Duration::ZERO).is_err());
    }
}
