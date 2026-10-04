//! Compares the Rust normalizer with fixtures produced by scripts/gen-normalize-fixtures.ts.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    titles: Vec<TitleCase>,
    title_sim: Vec<PairCase>,
    dice: Vec<PairCase>,
    artist_sim: Vec<ArtistCase>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleCase {
    input: String,
    norm: String,
    full_key: String,
    base_key: String,
}

#[derive(serde::Deserialize)]
struct PairCase {
    a: String,
    b: String,
    value: f64,
}

#[derive(serde::Deserialize)]
struct ArtistCase {
    names: Vec<String>,
    local: String,
    value: f64,
}

fn fixtures() -> Fixtures {
    serde_json::from_str(include_str!("fixtures/normalize.json")).unwrap()
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "{what}: rust {actual} != ts {expected}"
    );
}

#[test]
fn title_keys_match_typescript() {
    for case in fixtures().titles {
        assert_eq!(
            ssc_companion::normalize::norm(&case.input),
            case.norm,
            "norm({:?})",
            case.input
        );
        assert_eq!(
            ssc_companion::normalize::full_key(&case.input),
            case.full_key,
            "fullKey({:?})",
            case.input
        );
        assert_eq!(
            ssc_companion::normalize::base_key(&case.input),
            case.base_key,
            "baseKey({:?})",
            case.input
        );
    }
}

#[test]
fn similarities_match_typescript() {
    let fixtures = fixtures();
    for case in fixtures.title_sim {
        let what = format!("titleSim({:?}, {:?})", case.a, case.b);
        assert_close(
            ssc_companion::normalize::title_sim(&case.a, &case.b),
            case.value,
            &what,
        );
    }
    for case in fixtures.dice {
        let what = format!("dice({:?}, {:?})", case.a, case.b);
        assert_close(
            ssc_companion::normalize::dice(&case.a, &case.b),
            case.value,
            &what,
        );
    }
    for case in fixtures.artist_sim {
        let names: Vec<&str> = case.names.iter().map(String::as_str).collect();
        let what = format!("artistSim({:?}, {:?})", case.names, case.local);
        assert_close(
            ssc_companion::normalize::artist_sim(&names, &case.local),
            case.value,
            &what,
        );
    }
}
