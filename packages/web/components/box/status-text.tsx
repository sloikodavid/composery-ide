import {
	CircleCheckIcon,
	ClockIcon,
	ConstructionIcon,
	LoaderIcon,
	Trash2Icon,
	TriangleAlertIcon,
	Undo2Icon,
	UnplugIcon,
	ZapOffIcon
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type BoxOperationStatus } from "@/convex/model/box/operation";
import { type BoxStatus } from "@/convex/model/box/status";
import { type SnapshotStatus } from "@/convex/model/box/snapshot";
import { RunningIndicator } from "@/components/box/running-indicator";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger";
type Entry = { label: string; tone: Tone };

// A box, an operation, a snapshot and a Polar record each have their own set of
// statuses, and this renders all four. They are kept as four maps rather than one.
//
// They used to be flattened into a single `Record<BoxStatus | BoxOperationStatus |
// SnapshotStatus, Tone>`, which forced any word appearing in two of them to be a
// single row with a single tone and a single label. That reads as economy and is
// really a constraint: a box that is `creating` and a snapshot that is `creating`
// are different events that only happen to want the same English word today, and
// the shared row is what would stop one of them being reworded later. It also made
// the component's own prop `status: string`, so nothing checked that a snapshot
// status was not being passed where a box status belonged.
//
// Four maps, four exhaustive unions, one `kind` on the prop. A status added to any
// schema union fails the build in exactly one map, and each vocabulary is free to
// word itself.
const BOX: Record<BoxStatus, Entry> = {
	creating: { label: "Creating", tone: "warning" },
	running: { label: "Running", tone: "success" },
	create_failed: { label: "Couldn't create", tone: "danger" },
	stopping: { label: "Stopping", tone: "warning" },
	stopped: { label: "Stopped", tone: "danger" },
	starting: { label: "Starting", tone: "warning" },
	resetting: { label: "Resetting", tone: "warning" },
	reset_failed: { label: "Couldn't reset", tone: "danger" },
	repairing: { label: "Repairing", tone: "warning" },
	repair_failed: { label: "Couldn't repair", tone: "danger" },
	updating: { label: "Updating", tone: "warning" },
	update_failed: { label: "Couldn't update", tone: "danger" },
	restoring: { label: "Restoring", tone: "warning" },
	restore_failed: { label: "Couldn't restore", tone: "danger" },
	suspending: { label: "Suspending", tone: "warning" },
	suspended: { label: "Suspended", tone: "warning" },
	unsuspending: { label: "Unsuspending", tone: "warning" },
	deleting: { label: "Removing", tone: "warning" },
	delete_failed: { label: "Couldn't remove", tone: "danger" },
	deleted: { label: "Removed", tone: "neutral" }
};

const OPERATION: Record<BoxOperationStatus, Entry> = {
	pending: { label: "Pending", tone: "warning" },
	running: { label: "Running", tone: "warning" },
	succeeded: { label: "Succeeded", tone: "success" },
	failed: { label: "Failed", tone: "danger" }
};

const SNAPSHOT: Record<SnapshotStatus, Entry> = {
	pending: { label: "Pending", tone: "warning" },
	creating: { label: "Capturing", tone: "warning" },
	complete: { label: "Complete", tone: "success" },
	failed: { label: "Failed", tone: "danger" },
	deleting: { label: "Removing", tone: "warning" }
};

// Polar's vocabulary, which we do not own and cannot make exhaustive. It is the
// only one allowed to fall back, and the fallback title-cases rather than guesses
// a tone.
const FOREIGN: Record<string, Entry> = {
	active: { label: "Active", tone: "warning" },
	open: { label: "Open", tone: "warning" },
	confirmed: { label: "Confirmed", tone: "success" },
	converted: { label: "Converted", tone: "success" },
	expired: { label: "Expired", tone: "neutral" },
	released: { label: "Released", tone: "neutral" }
};

function foreignEntry(status: string): Entry {
	const text = status.replace(/_/g, " ");
	return {
		label: text.charAt(0).toUpperCase() + text.slice(1),
		tone: "neutral"
	};
}

// Statuses that mean "something is happening right now" and so spin. Named per
// vocabulary for the same reason as the labels: a box that is `running` is at
// rest, an operation that is `running` is in flight.
const SPINNING_BOX = new Set<BoxStatus>([
	"creating",
	"stopping",
	"starting",
	"resetting",
	"repairing",
	"updating",
	"restoring",
	"suspending",
	"unsuspending",
	"deleting"
]);
const SPINNING_OPERATION = new Set<BoxOperationStatus>(["pending", "running"]);
const SPINNING_SNAPSHOT = new Set<SnapshotStatus>([
	"pending",
	"creating",
	"deleting"
]);

// Terminal / inert states with a glyph of their own; everything else falls back
// to its tone's icon.
const BOX_ICONS: Partial<Record<BoxStatus, LucideIcon>> = {
	stopped: UnplugIcon,
	suspended: ConstructionIcon,
	deleted: Trash2Icon
};
const FOREIGN_ICONS: Record<string, LucideIcon> = {
	expired: Undo2Icon,
	released: Undo2Icon
};

const TONE_ICON: Record<Tone, LucideIcon> = {
	neutral: ZapOffIcon,
	success: CircleCheckIcon,
	warning: ClockIcon,
	danger: TriangleAlertIcon
};

const TONE_COLOR: Record<Tone, string> = {
	neutral: "text-foreground",
	success: "text-success",
	warning: "text-warning",
	danger: "text-destructive"
};

export type StatusTextProps = {
	className?: string;
	// The status glyph's own classes. Exists so a caller rendering a second glyph
	// beside this one can size the two alike: a 14px glyph and a 16px glyph in the
	// same slot put their labels two pixels apart, which reads as the text moving.
	iconClassName?: string;
} & (
	| { kind: "box"; status: BoxStatus }
	| { kind: "operation"; status: BoxOperationStatus }
	| { kind: "snapshot"; status: SnapshotStatus }
	| { kind: "foreign"; status: string }
);

function resolve(props: StatusTextProps): {
	entry: Entry;
	icon: LucideIcon | undefined;
	spinning: boolean;
} {
	switch (props.kind) {
		case "box":
			return {
				entry: BOX[props.status],
				icon: BOX_ICONS[props.status],
				spinning: SPINNING_BOX.has(props.status)
			};
		case "operation":
			return {
				entry: OPERATION[props.status],
				icon: undefined,
				spinning: SPINNING_OPERATION.has(props.status)
			};
		case "snapshot":
			return {
				entry: SNAPSHOT[props.status],
				icon: undefined,
				spinning: SPINNING_SNAPSHOT.has(props.status)
			};
		case "foreign":
			return {
				entry: FOREIGN[props.status] ?? foreignEntry(props.status),
				icon: FOREIGN_ICONS[props.status],
				spinning: false
			};
	}
}

export function StatusText(props: StatusTextProps) {
	const { entry, icon, spinning } = resolve(props);
	const Icon = icon ?? (spinning ? LoaderIcon : TONE_ICON[entry.tone]);
	const live = props.kind === "box" && props.status === "running";

	return (
		<span className={cn("inline-flex items-center gap-1.5", props.className)}>
			{live ? (
				<RunningIndicator className={props.iconClassName} />
			) : (
				<Icon
					className={cn(
						"size-3.5",
						TONE_COLOR[entry.tone],
						spinning && "animate-spin",
						props.iconClassName
					)}
				/>
			)}
			{entry.label}
		</span>
	);
}
