use anyhow::Result;
use clap::Subcommand;
use serde::Serialize;

use crate::certificates;
use crate::enrollments;
use crate::keystore;
use crate::output;

#[derive(Debug, Subcommand)]
pub enum SshCommand {
    /// Mint a single-use enrollment token for a device or agent.
    ///
    /// The token is what lets a machine with no API key ask this instance for an
    /// SSH certificate. It works once, expires shortly, and is printed here and
    /// nowhere else - only its hash is stored.
    Enroll {
        /// What the certificate will be called when it is issued.
        #[arg(long)]
        name: String,
    },
    /// List every certificate this instance has issued, live and revoked.
    List,
    /// Revoke one certificate by serial. Effective on the next connection;
    /// sessions already open are not closed.
    Revoke {
        /// Serial from `composery ssh list`.
        serial: u64,
    },
}

#[derive(Serialize)]
struct CertificateList {
    certificates: Vec<certificates::CertificateRecord>,
}

#[derive(Serialize)]
struct Revoked {
    serial: u64,
    revoked: bool,
}

#[derive(Serialize)]
struct MintedEnrollment {
    name: String,
    token: String,
    expires_at: u64,
}

pub fn run(command: SshCommand, json: bool) -> Result<()> {
    match command {
        SshCommand::Enroll { name } => {
            let path = enrollments::store_path();
            // The same lock the key store uses, so two mints cannot drop each
            // other's record. It locks a sibling file, not this one, so it does
            // not care that the store has a different shape.
            let _lock = keystore::lock_store(&path)?;
            let now = enrollments::now_ms();
            let (new, record) = enrollments::mint(&name, now)?;
            let mut records = enrollments::live(enrollments::load(&path)?, now);
            records.push(record.clone());
            enrollments::save(&path, &records)?;

            let minted = MintedEnrollment {
                name: record.name,
                token: new.token,
                expires_at: new.expires_at,
            };
            output::render(&minted, json, |minted| {
                println!("Enrollment token for {}:", minted.name);
                println!();
                println!("  {}", minted.token);
                println!();
                println!("It works once and expires shortly. Mint another if it is refused.");
            })
        }
        SshCommand::List => {
            let store = certificates::load(&certificates::store_path())?;
            let list = CertificateList {
                certificates: store.certificates,
            };
            output::render(&list, json, |list| {
                if list.certificates.is_empty() {
                    println!("No SSH certificates. Issue one with `composery ssh enroll`.");
                    return;
                }
                for record in &list.certificates {
                    let state = match record.revoked_at {
                        Some(_) => "revoked",
                        None => "live",
                    };
                    println!("{:>8}  {:<8}  {}", record.serial, state, record.name);
                }
            })
        }
        SshCommand::Revoke { serial } => {
            let path = certificates::store_path();
            let _lock = keystore::lock_store(&path)?;
            let mut store = certificates::load(&path)?;
            let revoked = certificates::revoke(&mut store, serial, enrollments::now_ms());
            if revoked {
                // The list sshd reads is written before the record that explains
                // it. If this order were reversed, a failure here would leave a
                // certificate marked revoked in the file and still accepted by
                // the server - the exact state nobody would think to check.
                certificates::write_revocation_list(&store)?;
                certificates::save(&path, &store)?;
            }
            output::render(&Revoked { serial, revoked }, json, |result| {
                if result.revoked {
                    println!("Revoked certificate {}.", result.serial);
                } else {
                    println!("No live certificate with serial {}.", result.serial);
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The empty-name refusal happens inside mint, after the lock is taken but
    // before anything is written, so run must return it rather than report
    // success. On a machine with no /data volume the lock itself fails first,
    // which is the same outcome for this assertion.
    #[test]
    fn run_propagates_command_failures() {
        let command = SshCommand::Enroll {
            name: String::new(),
        };
        assert!(run(command, false).is_err());
    }
}
