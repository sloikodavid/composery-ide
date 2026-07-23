"use client";

import { useAction } from "convex/react";
import { useEffect, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { SshCertificate } from "@/convex/model/box/ssh";
import { AgentStack } from "@/components/box/agent-stack";
import { Button } from "@/components/base/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import { Input } from "@/components/base/input";
import { CopyLinkButton } from "@/components/copy-link-button";
import { copyToClipboard } from "@/lib/clipboard";
import { useBusyAction } from "@/hooks/use-busy-action";

// Connect a device or an AI agent to this box over SSH.
//
// Two ways in, presented the way a sign-in dialog presents two ways in: the one
// most people want, a rule, then the one for people who already know what they
// are doing. Neither is a fallback for the other - pasting a prompt and typing
// `ssh` are both first class, and an owner who already has a key never needs a
// token at all.
//
// The token inside the prompt works once and expires in minutes, which is what
// makes suggesting you paste it into somebody else's model reasonable. The
// private key never exists here: the agent generates it on the machine that will
// connect and sends only the public half.

// Port 22 on a box is the instance's own sshd. Its container shares the host's
// network stack, and cloud-init moved the host's sshd aside so this could be true.
const SSH_PORT = 22;

export function SshDialog({
	host,
	slug,
	open,
	onOpenChange
}: {
	host: string;
	slug: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const setUp = useAction(api.owner.boxes.sshSetup);
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState<string | null>(null);
	const { run, busy } = useBusyAction();

	function reset(next: boolean) {
		if (!next) {
			setName("");
			setPrompt(null);
		}
		onOpenChange(next);
	}

	const alias = `composery-${slug}`;

	return (
		<Dialog onOpenChange={reset} open={open}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Connect remotely</DialogTitle>
					<DialogDescription>
						This box speaks SSH, so it can be reached like any server - a shell,
						file transfer, tunnels, and your editor&apos;s remote mode.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<AgentStack />
						<span className="font-medium text-sm">Let an agent set it up</span>
					</div>
					<p className="text-muted-foreground text-sm">
						Paste the prompt into Claude Desktop or ChatGPT Desktop. It
						generates its own key, sets up SSH on that machine, and connects
						itself - no private key is ever sent to you or through us.
					</p>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							aria-label="Name this connection"
							className="sm:flex-1"
							maxLength={64}
							onChange={(event) => setName(event.target.value)}
							placeholder="Name it, e.g. my laptop"
							value={name}
						/>
						{prompt ? (
							<CopyLinkButton
								label="Copy setup prompt"
								message="Prompt copied"
								value={prompt}
							/>
						) : (
							<Button
								disabled={busy !== null || !name.trim()}
								onClick={() =>
									// `run` owns the failure message, so a stopped box or a name
									// the control plane refuses reads like every other box
									// action's failure rather than like its own kind of error.
									run("ssh", null, async () => {
										const result = await setUp({ name: name.trim(), slug });
										setPrompt(result.prompt);
										await copyToClipboard(result.prompt, "Prompt copied");
									})
								}
							>
								{busy === "ssh" ? "Preparing…" : "Copy setup prompt"}
							</Button>
						)}
					</div>
					{prompt ? (
						<p className="text-muted-foreground text-sm">
							It works once and expires in minutes - come back for another if it
							is refused.
						</p>
					) : null}
				</div>

				<Separated>or connect it yourself</Separated>

				<div className="flex flex-col gap-2">
					<Field label="Command" value={`ssh ${alias}`} />
					<Field label="Host" value={host} />
					<Field label="Port" value={String(SSH_PORT)} />
					<Field label="User" value="user" />
					<p className="text-muted-foreground text-sm">
						Add your public key to <code>~/.ssh/authorized_keys</code> from the
						box&apos;s terminal first - that path needs no token at all.
					</p>
				</div>

				<SshDevices busy={busy} run={run} slug={slug} />
			</DialogContent>
		</Dialog>
	);
}

// The rule with a word in it, the way a sign-in dialog draws one. Two paths of
// equal standing, not a heading over a fallback. Kept without a border to
// match the rest of the page: the label alone separates the two halves.
function Separated({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3">
			<span className="text-muted-foreground text-xs uppercase tracking-wide">
				{children}
			</span>
		</div>
	);
}

// One connection detail, copyable on its own. Somebody putting these into a
// client copies them one at a time, and dragging a selection out of a paragraph
// is exactly where that goes wrong.
function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-muted-foreground text-sm">{label}</span>
			<div className="flex min-w-0 items-center gap-2">
				<code className="truncate text-sm">{value}</code>
				<CopyLinkButton
					aria-label={`Copy ${label.toLowerCase()}`}
					label=""
					message={`${label} copied`}
					size="icon"
					value={value}
					variant="ghost"
				/>
			</div>
		</div>
	);
}

// What can reach this box today, read live from the box each time the dialog
// opens. Nothing is cached here: a stale list of what has access is worse than no
// list, because it is the thing somebody checks before deciding they are safe.
function SshDevices({
	busy,
	run,
	slug
}: {
	busy: string | null;
	run: (
		name: string,
		success: string | null,
		work: () => Promise<unknown>
	) => Promise<void>;
	slug: string;
}) {
	const devices = useAction(api.owner.boxes.sshDevices);
	const revoke = useAction(api.owner.boxes.revokeSshDevice);
	const [list, setList] = useState<SshCertificate[] | null>(null);

	useEffect(() => {
		let live = true;
		devices({ slug })
			.then((result) => {
				if (live) setList(result);
			})
			// A box that cannot be reached shows nothing, rather than an empty table
			// claiming nothing has access.
			.catch(() => {
				if (live) setList(null);
			});
		return () => {
			live = false;
		};
	}, [devices, slug]);

	const connected = list?.filter((device) => !device.revoked) ?? [];
	if (connected.length === 0) return null;

	return (
		<>
			<Separated>already connected</Separated>
			<ul className="flex flex-col gap-1">
				{connected.map((device) => (
					<li
						className="flex items-center justify-between gap-2 text-sm"
						key={device.serial}
					>
						<span className="truncate">{device.name}</span>
						<Button
							disabled={busy !== null}
							onClick={() =>
								run("revoke", "Access revoked", async () => {
									await revoke({ serial: device.serial, slug });
									setList(await devices({ slug }));
								})
							}
							size="sm"
							variant="ghost"
						>
							Revoke
						</Button>
					</li>
				))}
			</ul>
		</>
	);
}
