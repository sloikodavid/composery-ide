use anyhow::Result;
use clap::Subcommand;
use serde::Serialize;

use crate::keystore::{self, KeyRecord};
use crate::output;

#[derive(Debug, Subcommand)]
pub enum ApiCommand {
    /// Manage API keys.
    #[command(subcommand)]
    Key(KeyCommand),
}

#[derive(Debug, Subcommand)]
pub enum KeyCommand {
    /// Create a new API key. The secret is printed once and never again.
    Create {
        /// Human label for the key.
        #[arg(long)]
        name: String,
    },
    /// List API keys. Secrets are never shown.
    List,
    /// Revoke an API key by id.
    Revoke {
        /// Key id from `composery api key list`.
        id: String,
    },
}

pub fn run(command: ApiCommand, json: bool) -> Result<()> {
    match command {
        ApiCommand::Key(command) => run_key(command, json),
    }
}

#[derive(Serialize)]
struct CreatedKey {
    id: String,
    name: String,
    prefix: String,
    created_at: u64,
    secret: String,
}

#[derive(Serialize)]
struct KeySummary {
    id: String,
    name: String,
    prefix: String,
    created_at: u64,
}

#[derive(Serialize)]
struct KeyList {
    keys: Vec<KeySummary>,
}

#[derive(Serialize)]
struct Revoked {
    id: String,
    revoked: bool,
}

fn run_key(command: KeyCommand, json: bool) -> Result<()> {
    let path = keystore::store_path();
    match command {
        KeyCommand::Create { name } => {
            let _lock = keystore::lock_store(&path)?;
            let mut store = keystore::load(&path)?;
            let new = store.create(&name)?;
            keystore::save(&path, &store)?;
            let created = CreatedKey {
                id: new.record.id,
                name: new.record.name,
                prefix: new.record.prefix,
                created_at: new.record.created_at,
                secret: new.secret,
            };
            output::render(&created, json, |created| {
                println!("Created API key {} ({}).", created.id, created.name);
                println!();
                println!("  {}", created.secret);
                println!();
                println!("This secret is shown once. Store it now - it cannot be recovered.");
            })
        }
        KeyCommand::List => {
            let store = keystore::load(&path)?;
            let list = KeyList {
                keys: store.keys.iter().map(summarize).collect(),
            };
            output::render(&list, json, print_key_list)
        }
        KeyCommand::Revoke { id } => {
            let _lock = keystore::lock_store(&path)?;
            let mut store = keystore::load(&path)?;
            let revoked = store.revoke(&id);
            if revoked {
                keystore::save(&path, &store)?;
            }
            output::render(&Revoked { id, revoked }, json, |result| {
                if result.revoked {
                    println!("Revoked API key {}.", result.id);
                } else {
                    println!("No API key with id {}.", result.id);
                }
            })
        }
    }
}

fn summarize(record: &KeyRecord) -> KeySummary {
    KeySummary {
        id: record.id.clone(),
        name: record.name.clone(),
        prefix: record.prefix.clone(),
        created_at: record.created_at,
    }
}

fn print_key_list(list: &KeyList) {
    if list.keys.is_empty() {
        println!("No API keys. Create one with `composery api key create --name <name>`.");
        return;
    }
    println!("{:<14}  {:<20}  {:<20}  CREATED", "ID", "NAME", "PREFIX");
    for key in &list.keys {
        println!(
            "{:<14}  {:<20}  {:<20}  {}",
            key.id,
            key.name,
            key.prefix,
            format_utc(key.created_at)
        );
    }
}

// JSON keeps created_at as epoch seconds (the stored contract); only the human
// table formats it. Hand-rolled to avoid a chrono dependency for one line.
fn format_utc(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// Howard Hinnant's civil_from_days: days since 1970-01-01 to (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use crate::output;

    use super::*;

    #[test]
    fn format_utc_matches_known_vectors() {
        assert_eq!(super::format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::format_utc(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(super::format_utc(1_772_064_000), "2026-02-26T00:00:00Z");
    }

    // The civil_from_days arithmetic keeps month boundaries and eras apart; a
    // single vector would pass on both the real and a broken formula. These
    // span the leap-day boundary, a negative era (1969), and the year 2100
    // (divisible by 100, not by 400).
    #[test]
    fn format_utc_keeps_calendar_boundaries() {
        assert_eq!(super::format_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(super::format_utc(1_518_134_400), "2018-02-09T00:00:00Z");
        assert_eq!(super::format_utc(4_103_913_600), "2100-01-18T00:00:00Z");
        assert_eq!(super::format_utc(2_147_472_000), "2038-01-19T00:00:00Z");
    }

    #[test]
    fn format_utc_handles_pre_epoch_dates() {
        // format_utc's input is unsigned, so the pre-epoch branch of the
        // calendar math is exercised through civil_from_days directly. The
        // -682944 vector sits at doe=36524, where the era-correction term
        // changes the quotient - a mutated operator would land a day off.
        assert_eq!(super::civil_from_days(-1), (1969, 12, 31));
        assert_eq!(super::civil_from_days(-365), (1969, 1, 1));
        assert_eq!(super::civil_from_days(-719_468), (0, 3, 1));
        assert_eq!(super::civil_from_days(-682_944), (100, 3, 1));
        assert_eq!(super::civil_from_days(-36_524), (1870, 1, 1));
    }

    // The human table and its "nothing here" guidance print to the process's
    // stdout, which the test harness intercepts before any test runs; they are
    // proven by the subprocess integration tests in tests/cli.rs.
    #[test]
    fn run_key_propagates_failures() {
        let command = KeyCommand::Create { name: String::new() };
        assert!(run_key(command, false).is_err());
    }
}
