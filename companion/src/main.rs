#[derive(clap::Parser)]
#[command(
    name = "ssc-companion",
    version,
    about = "Local library companion for spotify-shopping-cart"
)]
struct Cli {
    /// Data directory [default: <local data dir>/ssc-companion]
    #[arg(long, global = true)]
    data_dir: Option<std::path::PathBuf>,
    /// Config file [default: <data dir>/config.json]
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Index the libraries and answer the app on the configured loopback address (default)
    Serve,
    /// Print the pairing token
    Token {
        /// Replace the token; the app must be paired again
        #[arg(long)]
        rotate: bool,
    },
    /// Match a playlist from the app's debug export and print a summary
    Match {
        /// Path to spotify-shopping-cart-debug-*.json
        #[arg(long)]
        export: std::path::PathBuf,
        /// Skip iTunes Lookup and use cached store names only
        #[arg(long)]
        offline: bool,
        /// Print every owned and probable track
        #[arg(long)]
        verbose: bool,
    },
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cli = <Cli as clap::Parser>::parse();
    match run(cli).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> ssc_companion::error::Result<()> {
    let data_dir = match cli.data_dir {
        Some(dir) => dir,
        None => ssc_companion::config::default_data_dir()?,
    };
    std::fs::create_dir_all(&data_dir).map_err(|source| ssc_companion::error::Error::Io {
        context: format!("creating {}", data_dir.display()),
        source,
    })?;
    let config_path = cli.config.unwrap_or_else(|| data_dir.join("config.json"));
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(&data_dir, &config_path).await,
        Command::Token { rotate } => {
            if rotate {
                println!("{}", ssc_companion::secret::rotate_token(&data_dir)?);
                eprintln!(
                    "Restart `ssc-companion serve`; a running server keeps accepting the old token."
                );
            } else {
                println!(
                    "{}",
                    ssc_companion::secret::load_or_create_token(&data_dir)?.value
                );
            }
            Ok(())
        }
        Command::Match {
            export,
            offline,
            verbose,
        } => match_export(&data_dir, &config_path, &export, offline, verbose).await,
    }
}

async fn open(
    data_dir: &std::path::Path,
    config_path: &std::path::Path,
    token: String,
) -> ssc_companion::error::Result<(
    std::sync::Arc<ssc_companion::config::Config>,
    std::sync::Arc<ssc_companion::state::AppState>,
    ssc_companion::indexer::Indexer,
)> {
    let config = std::sync::Arc::new(ssc_companion::config::Config::load(config_path)?);
    let db = ssc_companion::db::Db::open(&data_dir.join(ssc_companion::db::DB_FILE)).await?;
    let id_key = ssc_companion::secret::load_or_create_id_key(data_dir)?;
    let state = std::sync::Arc::new(ssc_companion::state::AppState::new(&config, token));
    let indexer = ssc_companion::indexer::Indexer::new(config.clone(), db, state.clone(), id_key)?;
    Ok((config, state, indexer))
}

async fn serve(
    data_dir: &std::path::Path,
    config_path: &std::path::Path,
) -> ssc_companion::error::Result<()> {
    let token = ssc_companion::secret::load_or_create_token(data_dir)?;
    let (config, state, indexer) = open(data_dir, config_path, token.value.clone()).await?;
    println!(
        "ssc-companion {} listening on http://{}",
        env!("CARGO_PKG_VERSION"),
        config.listen
    );
    println!("Pairing token (paste it into the app): {}", token.value);
    tokio::spawn(indexer.run());
    ssc_companion::server::serve(state, config.listen, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

async fn match_export(
    data_dir: &std::path::Path,
    config_path: &std::path::Path,
    export: &std::path::Path,
    offline: bool,
    verbose: bool,
) -> ssc_companion::error::Result<()> {
    let json =
        std::fs::read_to_string(export).map_err(|source| ssc_companion::error::Error::Io {
            context: format!("reading {}", export.display()),
            source,
        })?;
    let tracks = ssc_companion::export::read_tracks(&json)?;
    let (_, state, mut indexer) = open(data_dir, config_path, String::new()).await?;
    indexer.cycle(!offline).await?;
    let index = state.index().expect("cycle publishes an index");
    let results = ssc_companion::matcher::match_tracks(&index, &tracks);

    let (mut by_isrc, mut by_metadata, mut probable_names, mut probable_duration, mut absent) =
        (0, 0, 0, 0, 0);
    for (track, result) in tracks.iter().zip(&results) {
        let best = result.matches.first();
        let label = match (result.verdict, result.matched_by) {
            (
                ssc_companion::protocol::Verdict::Owned,
                Some(ssc_companion::protocol::MatchedBy::Isrc),
            ) => {
                by_isrc += 1;
                "owned/isrc"
            }
            (ssc_companion::protocol::Verdict::Owned, _) => {
                by_metadata += 1;
                "owned/metadata"
            }
            (ssc_companion::protocol::Verdict::Probable, _)
                if best.is_some_and(|m| m.signals.title >= 0.85 && m.signals.artist >= 0.5) =>
            {
                probable_names += 1;
                "probable/names"
            }
            (ssc_companion::protocol::Verdict::Probable, _) => {
                probable_duration += 1;
                "probable/duration"
            }
            (ssc_companion::protocol::Verdict::Absent, _) => {
                absent += 1;
                continue;
            }
        };
        if let (true, Some(m)) = (verbose, best) {
            println!(
                "[{label}] {} | {} | {}\n    -> [{}/{:?}/{:?}] {} | {} t={} a={} al={:?} dur={:?}",
                track.title,
                track.artists.join(", "),
                track.album.title,
                m.source,
                m.ownership,
                m.metadata_source,
                m.title,
                m.location,
                m.signals.title,
                m.signals.artist,
                m.signals.album,
                m.signals.duration_delta_ms,
            );
        }
    }
    println!(
        "{} tracks, revision {}: owned {} (isrc {by_isrc}, metadata {by_metadata}), probable {} (names {probable_names}, duration {probable_duration}), absent {absent}",
        tracks.len(),
        index.revision,
        by_isrc + by_metadata,
        probable_names + probable_duration,
    );
    Ok(())
}
