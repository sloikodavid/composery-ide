"use node";

import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalAction, type ActionCtx } from "../../_generated/server";
import { requiredEnv, runtimeDomain, websiteOrigin } from "../../env";
import { vRecoveryStatus, type RecoveryStatus } from "../../model/box/recovery";
import { vSshCertificate, type SshCertificate } from "../../model/box/ssh";
import { resolvesToBox } from "../../model/box/domain";
import {
	HOST_SSH_PORT,
	renderComposeryEnv,
	renderCaddyfile,
	renderRuntimeArtifacts
} from "./artifacts";
import {
	DISK_SCRIPT,
	INSPECT_SCRIPT,
	UNREACHABLE_STATUS,
	applyRuntimeConfigScript,
	bootstrapScript,
	copyFromParkingScript,
	copyToParkingFromRescueScript,
	parseDiskUsage,
	parseParkingVerification,
	parseRuntimeInspection,
	reloadCaddyfileScript,
	repairScript,
	rewritePasswordScript,
	runtimeLogsScript,
	sshEnrollScript,
	sshListScript,
	sshRevokeScript,
	unmountParkingScript,
	unmountRescueScript,
	updateScript,
	verifyParkingScript
} from "./hostScripts";
import { privateKey } from "./hostCredentials";
import { HOUR_MS, MINUTE_MS } from "../../time";
import { runSsh, type SshTarget } from "./hostTransport";

export { runSsh } from "./hostTransport";

// The port the editor listens on inside the box, read from the deployment's own
// configuration. A non-integer or non-positive value would be rendered straight
// into a compose file and a Caddyfile, so it is refused here rather than
// producing a host that boots into a broken proxy.
export function runtimePort() {
	const value = Number(requiredEnv("RUNTIME_PORT"));
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error("RUNTIME_PORT must be a positive integer.");
	}
	return value;
}

// How many lines of runtime log to fetch. Clamped rather than trusted: the log
// stream is read over SSH into memory, so the ceiling is what keeps a caller
// asking for a million lines from being a request the action cannot survive.
export function logTail(value: number) {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error("Log tail must be a positive integer.");
	}
	return Math.min(value, 5000);
}

// The installed host, on the port cloud-init moved its sshd to. Port 22 there
// belongs to the instance, whose container shares this machine's network stack.
export function sshTarget(host: string): SshTarget {
	return {
		host,
		port: HOST_SSH_PORT,
		username: requiredEnv("HOST_SSH_USER"),
		privateKey: privateKey()
	};
}

// Rescue is a different operating system, booted in place of the installed
// one, and its sshd is on 22 like any stock system. Nothing Composery configured
// is running, which is exactly what makes rescue the way back into a host whose
// own SSH is broken - so this must NOT follow the port above.
export function rescueSshTarget(host: string): SshTarget {
	return { host, username: "root", privateKey: privateKey() };
}

export const inspectRuntime = internalAction({
	args: { boxId: v.id("boxes") },
	returns: vRecoveryStatus,
	handler: async (ctx, args): Promise<RecoveryStatus> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		if (!box.hetzner_ipv4) return UNREACHABLE_STATUS;

		try {
			const { stdout } = await runSsh(
				sshTarget(box.hetzner_ipv4),
				INSPECT_SCRIPT,
				{ maxOutputBytes: 64 * 1024, timeoutMs: 20_000 }
			);
			return parseRuntimeInspection(stdout);
		} catch {
			return UNREACHABLE_STATUS;
		}
	}
});

// How full this box's disk is, or null where the host could not say.
//
// Its own action rather than a field on the inspection above, because the two
// answer different questions on different schedules: the inspection is what a
// person opens the Repair dialog to read, and this is swept hourly across the
// whole fleet. Folding one into the other would either run every docker probe
// on every box every hour or leave the fleet's disk readings as stale as the
// last time somebody happened to open a dialog.
//
// A short timeout for the same reason: `df` on a working host answers instantly,
// and a host that needs longer than this is one the sweep should move past
// rather than hold a connection open for.
export const inspectDiskUsage = internalAction({
	args: { boxId: v.id("boxes") },
	returns: v.union(
		v.object({ totalBytes: v.number(), usedBytes: v.number() }),
		v.null()
	),
	handler: async (
		ctx,
		args
	): Promise<{ totalBytes: number; usedBytes: number } | null> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		if (!box.hetzner_ipv4) return null;

		try {
			const { stdout } = await runSsh(
				sshTarget(box.hetzner_ipv4),
				DISK_SCRIPT,
				{ maxOutputBytes: 4 * 1024, timeoutMs: 15_000 }
			);
			return parseDiskUsage(stdout);
		} catch {
			return null;
		}
	}
});

// The runtime files a box's SSH scripts write, built from its current row. One
// place so bootstrap and a repair's steps can never render them differently.
//
// `runtimeImage` overrides the row for the one operation that is deliberately
// writing a compose file the row does not describe yet: an update renders the
// image it is moving *to*, while `box.runtime_image` still records the last
// image known to serve. The row is only advanced once the new one has answered
// (see `updateBox`), which is what makes a failed update leave a compose file
// Repair can roll back from.
export function runtimeArtifactsForBox(
	box: Doc<"boxes">,
	runtimeImage?: string
) {
	const image = runtimeImage ?? box.runtime_image;
	if (!image) {
		throw new Error("Box has no runtime image.");
	}
	return renderRuntimeArtifacts({
		cloudBoxId: box._id,
		cloudOrigin: websiteOrigin(),
		config: box.runtime_config,
		customDomain: box.custom_domain,
		domain: runtimeDomain(box.slug),
		runtimeAuthHash: box.runtime_auth_hash,
		runtimeImage: image,
		runtimePort: runtimePort()
	});
}

// One data-preserving repair for a wedged box: rewrite the runtime files (in
// case they were damaged), re-pull the image, and force-recreate the stack. The
// box's files live in named volumes and are untouched.
export const repairRuntime = internalAction({
	args: {
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for repair.");
		}
		const artifacts = runtimeArtifactsForBox(box);

		await runSsh(sshTarget(box.hetzner_ipv4), repairScript(artifacts));
	}
});

// Move a running box to `runtimeImage`, keeping its files. The named volumes are
// untouched and the host is not rebuilt, so this is a container recreate: write
// the compose file naming the new image, pull it, bring the stack up, and hold
// until the editor answers.
//
// The image is passed in rather than read from the row on purpose. The caller
// only advances `box.runtime_image` after this returns, so if any step here
// throws, the row still names the image that last served and Repair - which
// renders from the row - rewrites the old compose file and puts the box back.
// That is the whole rollback mechanism; there is no separate one.
export const updateRuntime = internalAction({
	args: {
		boxId: v.id("boxes"),
		runtimeImage: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for update.");
		}
		const artifacts = runtimeArtifactsForBox(box, args.runtimeImage);

		await runSsh(sshTarget(box.hetzner_ipv4), updateScript(artifacts));
	}
});

export const bootstrapRuntime = internalAction({
	args: {
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for SSH bootstrap.");
		}
		const artifacts = runtimeArtifactsForBox(box);

		await runSsh(sshTarget(box.hetzner_ipv4), bootstrapScript(artifacts));
	}
});

// Apply an owner's configuration: rewrite the env file with it, recreate the
// editor's container so the new environment is actually read, and hold until the
// editor answers.
//
// The container recreate is not optional. Every variable here is read from
// `process.env` when the editor process starts, so a saved configuration that
// did not restart the container would be a setting the interface reports as
// applied and the box does not have - the inert path this repo treats as worse
// than a failure.
//
// Only the `composery` service is recreated (`--no-deps`), so Caddy and its TLS
// state are left alone; the second `up -d` puts back anything that stopped.
// Like an update, the config is passed in rather than read from the row: the
// caller advances the row only after this returns, so a failed apply leaves the
// box - and every later Repair, which renders from the row - on the last
// configuration known to boot.
export const applyRuntimeConfig = internalAction({
	args: {
		boxId: v.id("boxes"),
		config: v.record(v.string(), v.string())
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for configuration.");
		}

		const env = renderComposeryEnv({
			cloudBoxId: box._id,
			cloudOrigin: websiteOrigin(),
			config: args.config,
			runtimeAuthHash: box.runtime_auth_hash,
			runtimeImage: box.runtime_image
		});

		await runSsh(sshTarget(box.hetzner_ipv4), applyRuntimeConfigScript(env));
	}
});

export const rewritePasswordAndRestart = internalAction({
	args: {
		boxId: v.id("boxes"),
		runtimeAuthHash: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for password change.");
		}

		const env = renderComposeryEnv({
			cloudBoxId: box._id,
			cloudOrigin: websiteOrigin(),
			config: box.runtime_config,
			runtimeAuthHash: args.runtimeAuthHash,
			runtimeImage: box.runtime_image
		});
		await runSsh(
			sshTarget(box.hetzner_ipv4),
			rewritePasswordScript(env, args.runtimeAuthHash)
		);
	}
});

export const fetchRuntimeLogs = internalAction({
	args: {
		boxId: v.id("boxes"),
		tail: v.number()
	},
	handler: async (ctx, args): Promise<string> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for log access.");
		}

		const { stdout } = await runSsh(
			sshTarget(box.hetzner_ipv4),
			runtimeLogsScript(logTail(args.tail))
		);
		return stdout;
	}
});

export const reloadSlug = internalAction({
	args: {
		boxId: v.id("boxes"),
		newSlug: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		if (!box.hetzner_ipv4) {
			throw new Error("Box has no Hetzner IPv4 for slug change.");
		}

		const caddyfile = renderCaddyfile(
			runtimeDomain(args.newSlug),
			runtimePort(),
			box.custom_domain
		);
		await runSsh(sshTarget(box.hetzner_ipv4), reloadCaddyfileScript(caddyfile));
	}
});

// -- Repair (clean host, current files) -------------------------------------

export function requireBoxHost(box: Doc<"boxes">) {
	if (!box.hetzner_ipv4) {
		throw new Error(
			"This box has no reachable host. A host with broken networking or SSH can only be recovered by Restore."
		);
	}
	return box.hetzner_ipv4;
}

export const copyToParking = internalAction({
	args: { boxId: v.id("boxes"), volumeId: v.number() },
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		await runSsh(
			rescueSshTarget(host),
			copyToParkingFromRescueScript(args.volumeId),
			{
				timeoutMs: HOUR_MS
			}
		);
	}
});

// Copy the parked files back onto the rebuilt host. Writes the runtime files,
// materializes the empty volumes, and rsyncs the parked copy in - all before the
// stack is brought up, so nothing writes to a volume until its files are back.
export const copyFromParking = internalAction({
	args: { boxId: v.id("boxes"), volumeId: v.number() },
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		const artifacts = runtimeArtifactsForBox(box);
		await runSsh(
			sshTarget(host),
			copyFromParkingScript(artifacts, args.volumeId),
			{ timeoutMs: HOUR_MS }
		);
	}
});

async function verifyParking(
	ctx: ActionCtx,
	boxId: Doc<"boxes">["_id"],
	direction: "out" | "back",
	volumeId: number
) {
	const box = await ctx.runQuery(
		internal.boxes.queries.getBoxLifecycleSnapshot,
		{ boxId }
	);
	const host = requireBoxHost(box);
	const { stdout } = await runSsh(
		direction === "out" ? rescueSshTarget(host) : sshTarget(host),
		verifyParkingScript(direction, volumeId),
		{ maxOutputBytes: 4 * 1024 * 1024, timeoutMs: HOUR_MS }
	);
	const diffs = parseParkingVerification(stdout);
	const failure = parkingVerificationFailure(direction, diffs);
	if (failure) throw new Error(failure);
}

// The data-safety gate of a repair, as a decision rather than a step.
//
// Any difference at all stops the repair: the copy either matched or it did not,
// and continuing past a mismatch is the one path that ends with an owner's files
// gone. The count is reported in full and the list truncated, because the number
// is what tells an operator how bad it is while a million-line error is one
// nobody reads - and it was unreachable inside the SSH call that produced it.
export const PARKING_DIFFS_SHOWN = 50;

export function parkingVerificationFailure(
	direction: "out" | "back",
	diffs: readonly string[]
) {
	if (diffs.length === 0) return null;
	const shown = diffs.slice(0, PARKING_DIFFS_SHOWN).join("\n");
	return `Parking copy verification (${direction}) found ${diffs.length} difference(s); refusing to continue:\n${shown}`;
}

export const verifyParkingCopy = internalAction({
	args: { boxId: v.id("boxes"), volumeId: v.number() },
	handler: async (ctx, args) => {
		await verifyParking(ctx, args.boxId, "out", args.volumeId);
	}
});

export const verifyParkingBack = internalAction({
	args: { boxId: v.id("boxes"), volumeId: v.number() },
	handler: async (ctx, args) => {
		await verifyParking(ctx, args.boxId, "back", args.volumeId);
	}
});

export const unmountParking = internalAction({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		await runSsh(sshTarget(host), unmountParkingScript(), {
			timeoutMs: 5 * MINUTE_MS
		});
	}
});

export const unmountParkingFromRescue = internalAction({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		await runSsh(rescueSshTarget(host), unmountRescueScript(), {
			timeoutMs: 5 * MINUTE_MS
		});
	}
});

// -- SSH enrollment ---------------------------------------------------------

// Mint a single-use enrollment token on the box, for an owner connecting a
// device or an agent from the website.
//
// The website originates this - a token it asked for is not a copy of anything -
// but it never lists or revokes certificates. Those live on the instance, and a
// second copy of that list here would be one nobody could keep true. See
// `docs/ssh.md`.
export const mintSshEnrollment = internalAction({
	args: { boxId: v.id("boxes"), name: v.string() },
	returns: v.object({ token: v.string(), expiresAt: v.number() }),
	handler: async (ctx, args): Promise<{ token: string; expiresAt: number }> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);

		const { stdout } = await runSsh(
			sshTarget(host),
			sshEnrollScript(args.name),
			{ maxOutputBytes: 64 * 1024, timeoutMs: 30_000 }
		);
		return parseSshEnrollment(stdout);
	}
});

// The CLI prints the token once and nothing can recover it afterwards, so an
// answer this cannot read is a failure rather than a blank to pass on. A caller
// handed an empty token would show the owner a prompt that silently cannot work.
export function parseSshEnrollment(stdout: string): {
	token: string;
	expiresAt: number;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error("The box did not return an enrollment token.");
	}
	const value = parsed as { token?: unknown; expires_at?: unknown };
	if (typeof value.token !== "string" || !value.token) {
		throw new Error("The box did not return an enrollment token.");
	}
	if (typeof value.expires_at !== "number") {
		throw new Error("The box returned an enrollment token with no expiry.");
	}
	return { token: value.token, expiresAt: value.expires_at };
}

// What can currently reach this box over SSH, read from the box itself.
export const listSshCertificates = internalAction({
	args: { boxId: v.id("boxes") },
	returns: v.array(vSshCertificate),
	handler: async (ctx, args): Promise<SshCertificate[]> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		const { stdout } = await runSsh(sshTarget(host), sshListScript(), {
			maxOutputBytes: 512 * 1024,
			timeoutMs: 30_000
		});
		return parseSshCertificates(stdout);
	}
});

export const revokeSshCertificate = internalAction({
	args: { boxId: v.id("boxes"), serial: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		const { stdout } = await runSsh(
			sshTarget(host),
			sshRevokeScript(args.serial),
			{ maxOutputBytes: 64 * 1024, timeoutMs: 30_000 }
		);
		return parseSshRevocation(stdout);
	}
});

// An unreadable answer is a failure, never an empty list. "Nothing can reach this
// box" and "we could not ask" look identical in a table and mean opposite things.
export function parseSshCertificates(stdout: string): SshCertificate[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error("The box did not report its SSH certificates.");
	}
	const value = parsed as { certificates?: unknown };
	if (!Array.isArray(value.certificates)) {
		throw new Error("The box did not report its SSH certificates.");
	}
	return value.certificates.map((entry) => {
		const record = entry as Record<string, unknown>;
		if (
			typeof record.serial !== "number" ||
			typeof record.name !== "string" ||
			typeof record.created_at !== "number"
		) {
			throw new Error("The box reported a certificate it could not describe.");
		}
		return {
			serial: record.serial,
			name: record.name,
			createdAt: record.created_at,
			revoked: typeof record.revoked_at === "number"
		};
	});
}

export function parseSshRevocation(stdout: string): boolean {
	try {
		const value = JSON.parse(stdout.trim()) as { revoked?: unknown };
		if (typeof value.revoked !== "boolean") {
			throw new Error("unreadable");
		}
		return value.revoked;
	} catch {
		throw new Error("The box did not confirm the revocation.");
	}
}

// -- Custom domains ---------------------------------------------------------

// Ask a public resolver what a name points at.
//
// DNS-over-HTTPS rather than a resolver library: a Convex action can make an
// HTTPS request and cannot open a UDP socket, and the answer only has to be good
// enough to refuse a name that plainly does not point here. It is a gate against
// a certificate authority rate-limiting the box, not an authentication step.
export async function resolveDomain(name: string): Promise<string[]> {
	const answers: string[] = [];
	for (const type of ["A", "AAAA"]) {
		const response = await fetch(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
			{ headers: { accept: "application/dns-json" } }
		);
		if (!response.ok) {
			throw new Error("Could not look up that domain right now.");
		}
		const body = (await response.json()) as {
			Answer?: { data?: unknown; type?: unknown }[];
		};
		for (const answer of body.Answer ?? []) {
			if (typeof answer.data === "string") answers.push(answer.data);
		}
	}
	return answers;
}

export const checkCustomDomain = internalAction({
	args: { boxId: v.id("boxes"), domain: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const answers = await resolveDomain(args.domain);
		return resolvesToBox(answers, box.hetzner_ipv4, box.hetzner_ipv6);
	}
});

// Rewrite the box's Caddyfile so it serves the custom name too, and reload in
// place. The same shape as a slug change, for the same reason: this is the one
// other operation that changes a live box's public name without recreating it.
export const reloadCustomDomain = internalAction({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		const host = requireBoxHost(box);
		const caddyfile = renderCaddyfile(
			runtimeDomain(box.slug),
			runtimePort(),
			box.custom_domain
		);
		await runSsh(sshTarget(host), reloadCaddyfileScript(caddyfile));
	}
});
