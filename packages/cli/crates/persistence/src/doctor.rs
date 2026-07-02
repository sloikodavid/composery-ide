use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{internal::StateDb, metadata, paths::Paths};

#[cfg(unix)]
use crate::{baseline::BaselineDb, public};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub metadata_records: usize,
    pub rebuilt_public_index: bool,
    pub baseline_present: bool,
    pub baseline_valid: bool,
    pub changed_entries: usize,
    pub removed_markers: usize,
    pub findings: Vec<String>,
}

pub fn run(paths: &Paths, db: &StateDb) -> Result<DoctorReport> {
    let metadata_records = metadata::compact(&paths.metadata_file)?;
    db.rebuild_public_index(paths)?;

    let mut findings = Vec::new();
    let baseline_present = paths.baseline_db.exists();
    if !baseline_present {
        findings.push(format!("missing baseline: {}", paths.baseline_db.display()));
    }

    #[cfg(unix)]
    {
        let baseline_valid = baseline_present && BaselineDb::open(&paths.baseline_db).is_ok();
        if baseline_present && !baseline_valid {
            findings.push(format!("invalid baseline: {}", paths.baseline_db.display()));
        }

        let changed_paths = public::list_public_paths(&paths.changed_dir)?;
        let removed_paths = public::list_public_file_paths(&paths.removed_dir)?;
        let changed_keys = changed_paths
            .iter()
            .map(|path| path.as_bytes().to_vec())
            .collect::<std::collections::BTreeSet<_>>();

        for removed in &removed_paths {
            if changed_keys.contains(removed.as_bytes()) {
                findings.push(format!("changed/removed conflict: {removed}"));
            }
        }

        if baseline_valid {
            let baseline = BaselineDb::open(&paths.baseline_db)?;
            for record in &metadata_records {
                let public_path = record.public_path()?;
                let changed_exists = public_path.destination(&paths.changed_dir).exists();
                let baseline_exists = baseline.get(&public_path)?.is_some();
                let fallback_only = matches!(
                    record.kind.as_str(),
                    "fifo" | "char_device" | "block_device"
                );
                if !changed_exists && !baseline_exists && !fallback_only {
                    findings.push(format!("stale metadata: {public_path}"));
                }
            }
        }

        Ok(DoctorReport {
            metadata_records: metadata_records.len(),
            rebuilt_public_index: true,
            baseline_present,
            baseline_valid,
            changed_entries: changed_paths.len(),
            removed_markers: removed_paths.len(),
            findings,
        })
    }

    #[cfg(not(unix))]
    {
        Ok(DoctorReport {
            metadata_records: metadata_records.len(),
            rebuilt_public_index: true,
            baseline_present,
            baseline_valid: baseline_present,
            changed_entries: 0,
            removed_markers: 0,
            findings,
        })
    }
}

// Prints to the process's stdout, which the test harness intercepts before any
// test runs; the report itself is the tested artifact.
#[cfg_attr(test, mutants::skip)]
pub fn print_human(report: &DoctorReport) {
    println!("persistence doctor:");
    println!("  metadataRecords: {}", report.metadata_records);
    println!("  rebuiltPublicIndex: {}", report.rebuilt_public_index);
    println!("  baselinePresent: {}", report.baseline_present);
    println!("  baselineValid: {}", report.baseline_valid);
    println!("  changedEntries: {}", report.changed_entries);
    println!("  removedMarkers: {}", report.removed_markers);
    if report.findings.is_empty() {
        println!("  findings: none");
    } else {
        for finding in &report.findings {
            println!("  finding: {finding}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::run;
    use crate::{
        baseline::{GenerateOptions, generate},
        internal::StateDb,
        layout,
        metadata::{self, MetadataRecord},
        paths::Paths,
        public::PublicPath,
    };
    use std::fs;

    #[test]
    fn doctor_reports_conflicts_and_stale_metadata_without_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        generate(&GenerateOptions {
            root,
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        fs::write(paths.changed_dir.join("conflict"), "changed").unwrap();
        fs::write(paths.removed_dir.join("conflict"), "").unwrap();

        let public_path = PublicPath::parse("/stale").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "file".into(),
            mode: None,
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(&paths.metadata_file, record).unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let report = run(&paths, &db).unwrap();

        assert!(report.baseline_valid);
        assert_eq!(report.changed_entries, 1);
        assert_eq!(report.removed_markers, 1);
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.contains("changed/removed conflict"))
        );
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.contains("stale metadata"))
        );
        assert!(paths.changed_dir.join("conflict").exists());
        assert!(paths.removed_dir.join("conflict").exists());
    }

    #[test]
    fn doctor_reports_missing_and_invalid_baseline() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();

        let missing = run(&paths, &db).unwrap();

        assert!(!missing.baseline_present);
        assert!(!missing.baseline_valid);
        assert!(
            missing
                .findings
                .iter()
                .any(|finding| finding.contains("missing baseline"))
        );
        // A missing baseline is one finding, not two: "invalid" is only a real
        // statement when the file exists to be invalid.
        assert!(
            !missing
                .findings
                .iter()
                .any(|finding| finding.contains("invalid baseline"))
        );

        fs::create_dir_all(&paths.opt_dir).unwrap();
        fs::write(&paths.baseline_db, "not sqlite").unwrap();
        let invalid = run(&paths, &db).unwrap();

        assert!(invalid.baseline_present);
        assert!(!invalid.baseline_valid);
        assert!(
            invalid
                .findings
                .iter()
                .any(|finding| finding.contains("invalid baseline"))
        );
    }

    // A metadata record whose path still exists in the baseline is not stale
    // (the file may arrive via the baseline on apply), and a fifo/device record
    // is never stale by itself - those kinds legitimately exist only as
    // metadata. Both must stay silent or the doctor would report the volume
    // broken when it is not.
    #[test]
    fn doctor_does_not_report_baseline_present_or_fallback_only_records_as_stale() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        generate(&GenerateOptions {
            root,
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();

        let mut baseline_record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "dir".into(),
            mode: None,
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        baseline_record.set_public_path(&PublicPath::parse("/opt/persistence").unwrap());
        metadata::upsert(&paths.metadata_file, baseline_record).unwrap();

        let mut fifo_record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: String::new(),
            kind: "fifo".into(),
            mode: None,
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        fifo_record.set_public_path(&PublicPath::parse("/opt/persistence/pipe").unwrap());
        metadata::upsert(&paths.metadata_file, fifo_record).unwrap();

        let report = run(&paths, &db).unwrap();

        let stale: Vec<_> = report
            .findings
            .iter()
            .filter(|finding| finding.contains("stale metadata"))
            .collect();
        assert_eq!(stale, Vec::<&String>::new(), "{:?}", report.findings);
    }

    #[test]
    fn doctor_compacts_metadata_and_rebuilds_public_index() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        generate(&GenerateOptions {
            root,
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        fs::create_dir_all(paths.changed_dir.join("etc")).unwrap();
        fs::write(paths.changed_dir.join("etc/hello"), "changed").unwrap();
        fs::write(
            &paths.metadata_file,
            r#"{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"file","mode":420}
{"version":1,"path":"/a","pathBytesB64":"L2E=","kind":"file","mode":384}
"#,
        )
        .unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();

        let report = run(&paths, &db).unwrap();

        assert!(report.rebuilt_public_index);
        assert_eq!(report.metadata_records, 1);
        assert_eq!(db.public_count("changed").unwrap(), 2);
        assert_eq!(db.metadata_record_count().unwrap(), 1);
        assert_eq!(
            metadata::load(&paths.metadata_file).unwrap()[0].mode,
            Some(384)
        );
    }

    #[test]
    fn doctor_rejects_invalid_metadata_path_without_rewriting_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        fs::create_dir_all(root.join("opt/persistence")).unwrap();
        generate(&GenerateOptions {
            root,
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let invalid_metadata = r#"{"version":1,"path":"/../escape","pathBytesB64":"Ly4uL2VzY2FwZQ==","kind":"file"}
"#;
        fs::write(&paths.metadata_file, invalid_metadata).unwrap();

        let error = run(&paths, &db).unwrap_err().to_string();

        assert!(error.contains(".."), "{error}");
        assert_eq!(
            fs::read_to_string(&paths.metadata_file).unwrap(),
            invalid_metadata
        );
    }
}
