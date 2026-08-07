import type { RecoveryStatus } from "@/convex/model/box/recovery";

// What a box dialog makes of a state it read rather than one it controls.
// `muted` means "we could not read this", never "this is fine" - `summarize`
// leans on that distinction to keep an unread box from reporting itself healthy,
// and `lib/runtime-update` leans on it to keep a box we cannot compare from
// reporting itself up to date. `ui/box/tone-icon` draws it.
export type Tone = "ok" | "warn" | "bad" | "muted";

export type Check = {
	label: string;
	description: string;
	state: { label: string; tone: Tone };
};

type ComponentState = RecoveryStatus["docker"];

function serviceState(state: ComponentState): {
	label: string;
	tone: Tone;
} {
	switch (state) {
		case "active":
			return { label: "Running", tone: "ok" };
		case "inactive":
			return { label: "Stopped", tone: "warn" };
		case "missing":
			return { label: "Missing", tone: "bad" };
		default:
			return { label: "Unknown", tone: "muted" };
	}
}

// Informational, not pass/fail: both engines are healthy answers, so neither is
// an issue. Only the daemon can name the live engine, so an unreadable one is
// `muted` ("we could not read this") like every other unread check - never a
// guess at which engine is running.
function engineState(engine: RecoveryStatus["engine"]): {
	label: string;
	tone: Tone;
} {
	if (engine === "overlay") return { label: "Overlay", tone: "ok" };
	if (engine === "copy") return { label: "Copy", tone: "ok" };
	return { label: "Unknown", tone: "muted" };
}

// What the dialog lists, and how each row reads itself off an inspection. The
// label and description do not depend on the box, so the dialog can lay every
// row out before the check returns and fill in only the state - the list never
// changes height, which is what stops the modal resizing under the pointer.
//
// Every row is a layer Repair can rebuild. A full disk used to sit here too
// and was the one row that broke the rule: it is a level against an allowance
// rather than a service that is up or down, and rebuilding the host does not
// free a byte of it. It is now a meter on the box page beside this button, with
// its own limit, its own notice and its own remedy - see
// `components/box/usage-card.tsx` and `convex/model/box/usage.ts`.
export const CHECKS: {
	label: string;
	description: string;
	read: (status: RecoveryStatus) => Check["state"];
}[] = [
	{
		label: "Website",
		description: "Reachable at its public URL.",
		read: (status) =>
			status.httpReachable
				? { label: "Online", tone: "ok" }
				: { label: "Not responding", tone: "bad" }
	},
	{
		label: "Server",
		description: "The host it runs on.",
		read: (status) =>
			status.hostReachable
				? { label: "Reachable", tone: "ok" }
				: { label: "Unreachable", tone: "bad" }
	},
	{
		label: "Docker",
		description: "Container engine.",
		read: (status) => serviceState(status.docker)
	},
	{
		label: "Reverse proxy",
		description: "Terminates HTTPS at the edge.",
		read: (status) => serviceState(status.outerCaddy)
	},
	{
		label: "Runtime container",
		description: "Everything runs in here.",
		read: (status) => serviceState(status.composery)
	},
	{
		label: "Editor",
		description: "The editor and terminal.",
		read: (status) => serviceState(status.ide)
	},
	{
		label: "Web server",
		description: "Serves the editor.",
		read: (status) => serviceState(status.caddy)
	},
	{
		label: "Persistence",
		description: "Saves your files.",
		read: (status) => serviceState(status.persistence)
	},
	{
		label: "Persistence engine",
		description: "How your changes are saved.",
		read: (status) => engineState(status.engine)
	}
];

export function buildChecks(status: RecoveryStatus): Check[] {
	return CHECKS.map((check) => ({
		label: check.label,
		description: check.description,
		state: check.read(status)
	}));
}

// The one line at the top of the dialog. It reads the inspection rather than a
// list of checks handed to it, so the summary and the rows below it are
// answering from the same reading by construction - a caller cannot summarise
// one set of checks while drawing another.
export function summarize(status: RecoveryStatus): {
	label: string;
	tone: Tone;
} {
	if (!status.hostReachable) {
		return { label: "The box is unreachable", tone: "bad" };
	}
	const checks = buildChecks(status);
	const issues = checks.filter(
		(check) => check.state.tone === "bad" || check.state.tone === "warn"
	).length;
	if (issues > 0) {
		return {
			label: `${issues} ${issues === 1 ? "issue" : "issues"} found`,
			tone: "warn"
		};
	}
	// An unread check is not a passing one. SSH can succeed while the probe
	// itself comes back empty, and calling that "healthy" is the one answer the
	// dialog must never give a box the owner came here to fix.
	if (checks.some((check) => check.state.tone === "muted")) {
		return { label: "Some checks could not be read", tone: "warn" };
	}
	return { label: "Everything looks healthy", tone: "ok" };
}
