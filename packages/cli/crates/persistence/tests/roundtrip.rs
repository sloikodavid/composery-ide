#![cfg(unix)]

use persistence::{
    apply, baseline,
    config::Config,
    internal::StateDb,
    layout,
    paths::Paths,
    prune, rootfs,
    update::{self, UpdateContext},
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

#[test]
fn prune_never_removes_public_truth_a_fresh_apply_still_needs() {
    let fixture = Fixture::new();
    // Every delta kind that a later apply depends on:
    fs::write(fixture.source_root.join("new.txt"), "new").unwrap();
    fs::write(fixture.source_root.join("etc/image"), "user image").unwrap();
    fs::remove_file(fixture.source_root.join("etc/delete-me")).unwrap();
    fs::set_permissions(
        fixture.source_root.join("etc/untouched"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::write(fixture.source_root.join("hl-a"), "same").unwrap();
    fs::hard_link(
        fixture.source_root.join("hl-a"),
        fixture.source_root.join("hl-b"),
    )
    .unwrap();
    // Plus one changed entry prune SHOULD remove: a baseline-equal symlink copy.
    fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
    symlink("/etc/image", fixture.paths.changed_dir.join("etc/link")).unwrap();

    let baseline = baseline::BaselineDb::open(&fixture.paths.baseline_db).unwrap();
    let config = Config::default();
    let ctx = UpdateContext {
        root: &fixture.source_root,
        paths: &fixture.paths,
        config: &config,
        baseline: &baseline,
    };
    for path in [
        "/new.txt",
        "/etc/image",
        "/etc/delete-me",
        "/etc/untouched",
        "/hl-a",
        "/hl-b",
    ] {
        update::update_path(&ctx, path).unwrap();
    }

    let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
    let report = prune::run(
        &fixture.source_root,
        &fixture.paths,
        &config,
        &baseline,
        &db,
    )
    .unwrap();
    assert!(
        report
            .removed
            .iter()
            .any(|item| item == "baseline-equal changed /etc/link"),
        "{report:?}"
    );
    assert!(!fixture.paths.changed_dir.join("etc/link").exists());
    // Prune is idempotent: a second pass removes nothing more.
    let report = prune::run(
        &fixture.source_root,
        &fixture.paths,
        &config,
        &baseline,
        &db,
    )
    .unwrap();
    assert_eq!(report.removed, Vec::<String>::new());

    let target_root = fixture.fresh_image_root();
    apply::apply_public_truth(&target_root, &fixture.paths, &config).unwrap();

    assert_eq!(
        fs::read_to_string(target_root.join("new.txt")).unwrap(),
        "new"
    );
    assert_eq!(
        fs::read_to_string(target_root.join("etc/image")).unwrap(),
        "user image"
    );
    assert!(!target_root.join("etc/delete-me").exists());
    let untouched = fs::metadata(target_root.join("etc/untouched")).unwrap();
    assert_eq!(untouched.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        fs::read_to_string(target_root.join("etc/untouched")).unwrap(),
        "new image"
    );
    assert_eq!(
        rootfs::facts(&target_root.join("hl-a")).unwrap().ino,
        rootfs::facts(&target_root.join("hl-b")).unwrap().ino
    );
    assert_eq!(
        fs::read_link(target_root.join("etc/link")).unwrap(),
        std::path::PathBuf::from("/etc/image")
    );
}

struct Fixture {
    _temp: tempfile::TempDir,
    source_root: std::path::PathBuf,
    paths: Paths,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source_root = temp.path().join("source-root");
        let paths = Paths::new(
            source_root.join("opt/persistence"),
            temp.path().join("run/persistence"),
            temp.path().join("data/persistence"),
        );
        create_image_root(&source_root, ImageVersion::Initial);
        baseline::generate(&baseline::GenerateOptions {
            root: source_root.clone(),
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        Self {
            _temp: temp,
            source_root,
            paths,
        }
    }

    fn fresh_image_root(&self) -> std::path::PathBuf {
        let root = self._temp.path().join("target-root");
        create_image_root(&root, ImageVersion::Updated);
        root
    }
}

#[derive(Clone, Copy)]
enum ImageVersion {
    Initial,
    Updated,
}

fn create_image_root(root: &std::path::Path, version: ImageVersion) {
    fs::create_dir_all(root.join("etc")).unwrap();
    fs::create_dir_all(root.join("opt/persistence")).unwrap();
    let (image, untouched, delete_me) = match version {
        ImageVersion::Initial => ("image", "old image", "delete"),
        ImageVersion::Updated => ("new image", "new image", "new delete"),
    };
    fs::write(root.join("etc/image"), image).unwrap();
    fs::write(root.join("etc/untouched"), untouched).unwrap();
    fs::write(root.join("etc/delete-me"), delete_me).unwrap();
    symlink("/etc/image", root.join("etc/link")).unwrap();
}
