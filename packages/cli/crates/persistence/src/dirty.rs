#![cfg(unix)]

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc,
};

use crate::public::PublicPath;

/// Hard bound on the dirty-path queue between the watcher/auditor and the
/// writer. Backpressure here is shed, not blocked: when the writer falls
/// behind, `send` drops the path (the rolling audit re-discovers it) rather
/// than growing the channel without limit, so queue memory can never scale
/// with the event rate. At ~a few dozen bytes per queued path this bounds the
/// channel to a few MiB.
///
/// This clamp, together with the watch budget, is the real memory fix for the
/// OOM incident. The systemd unit adds a `MemoryMax=` backstop, but the
/// supervisord init profile (`rootfs/etc/supervisor/`) has no per-program
/// memory limit and never will - these internal bounds are what keep the
/// daemon bounded under either init, so nothing needs to be added there.
pub const DIRTY_QUEUE_BOUND: usize = 65_536;

#[derive(Clone)]
pub struct DirtySender {
    tx: mpsc::SyncSender<PublicPath>,
    pending: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
}

impl DirtySender {
    /// Create the bounded dirty channel and its sender. The bound lives on the
    /// channel itself, so every clone of the sender shares one hard limit.
    pub fn bounded(pending: Arc<AtomicU64>) -> (Self, mpsc::Receiver<PublicPath>) {
        let (tx, rx) = mpsc::sync_channel(DIRTY_QUEUE_BOUND);
        (
            Self {
                tx,
                pending,
                dropped: Arc::new(AtomicU64::new(0)),
            },
            rx,
        )
    }

    pub fn send(&self, public_path: PublicPath) -> Result<(), mpsc::SendError<PublicPath>> {
        self.pending.fetch_add(1, Ordering::SeqCst);
        match self.tx.try_send(public_path) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => {
                // Shed, do not block or grow: the audit is the recovery floor,
                // so a dropped dirty path is re-found within one audit interval.
                mark_processed(&self.pending);
                self.dropped.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            Err(mpsc::TrySendError::Disconnected(public_path)) => {
                mark_processed(&self.pending);
                Err(mpsc::SendError(public_path))
            }
        }
    }

    pub fn mark_processed(&self) {
        mark_processed(&self.pending);
    }

    pub fn pending_count(&self) -> u64 {
        pending_count(&self.pending)
    }

    /// Total dirty paths shed because the queue was full since startup. A rising
    /// value is the signal that the daemon is under sustained write pressure.
    pub fn dropped_total(&self) -> u64 {
        self.dropped.load(Ordering::SeqCst)
    }
}

pub fn pending_count(pending: &AtomicU64) -> u64 {
    pending.load(Ordering::SeqCst)
}

pub fn mark_processed(pending: &AtomicU64) {
    let _ = pending.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        Some(value.saturating_sub(1))
    });
}

#[cfg(test)]
mod tests {
    use super::{DIRTY_QUEUE_BOUND, DirtySender, pending_count};
    use std::sync::{Arc, atomic::AtomicU64};

    #[test]
    fn sender_tracks_pending_depth() {
        let pending = Arc::new(AtomicU64::new(0));
        let (sender, rx) = DirtySender::bounded(Arc::clone(&pending));

        sender
            .send(crate::public::PublicPath::parse("/etc/hosts").unwrap())
            .unwrap();

        assert_eq!(pending_count(&pending), 1);
        assert_eq!(rx.recv().unwrap().as_bytes(), b"/etc/hosts");
        sender.mark_processed();
        assert_eq!(pending_count(&pending), 0);
    }

    #[test]
    fn full_queue_sheds_instead_of_growing() {
        let pending = Arc::new(AtomicU64::new(0));
        let (sender, _rx) = DirtySender::bounded(Arc::clone(&pending));

        // Fill the channel to its hard bound; nothing drains _rx.
        for index in 0..DIRTY_QUEUE_BOUND {
            sender
                .send(crate::public::PublicPath::parse(&format!("/f{index}")).unwrap())
                .unwrap();
        }
        assert_eq!(sender.dropped_total(), 0);
        assert_eq!(sender.pending_count(), DIRTY_QUEUE_BOUND as u64);

        // The next sends are shed (Ok, not an error, not queued) and counted.
        for _ in 0..10 {
            sender
                .send(crate::public::PublicPath::parse("/overflow").unwrap())
                .unwrap();
        }
        assert_eq!(sender.dropped_total(), 10);
        assert_eq!(sender.pending_count(), DIRTY_QUEUE_BOUND as u64);
    }
}
