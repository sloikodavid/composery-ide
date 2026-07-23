"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import { Button } from "@/components/base/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from "@/components/base/card";
import { Notice, recreateNotice } from "@/components/box/operation-dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from "@/components/base/tooltip";
import { api } from "@/convex/_generated/api";
import type { RuntimeConfigField } from "@/convex/boxes/configuration";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useReseed } from "@/hooks/use-reseed";
import { boxPath } from "@/convex/model/box/path";
import { errorMessage } from "@/lib/error-message";
import {
	ConfigField,
	isDangerousField,
	isSecretField,
	KEEP_SECRET,
	SecretField,
	type SecretIntent
} from "./config-field";

// Why every control is greyed out. A tooltip on each disabled control says
// this where the reader is looking, instead of the page saying it once at the
// top where it only registers for the fields below it.
const READ_ONLY_REASON =
	"The box is not running, so its configuration is read-only.";

// Which group a variable lands in is decided by its key and its `dangerous`
// flag, never by a list of keys held here: a variable added to the allowlist
// matches one of these rules or falls through to the last, so it always renders.
// First match wins, which is why the API rule is asked before the broader
// COMPOSERY_ one - `COMPOSERY_DISABLE_API` belongs with the API's limits.
const GROUPS: {
	description: string;
	holds: (field: RuntimeConfigField) => boolean;
	title: string;
}[] = [
	{
		description:
			"These weaken how the box protects itself. Each one asks you to type the box name before it can be turned on.",
		holds: isDangerousField,
		title: "Dangerous"
	},
	{
		description: "The box's HTTP API, and the limits it holds callers to.",
		holds: (field) => field.key.includes("_API"),
		title: "Automation API"
	},
	{
		description:
			"How the editor starts, and what it offers when it is running.",
		holds: (field) => field.key.startsWith("COMPOSERY_"),
		title: "Editor"
	},
	{
		description:
			"Plain environment variables the box and the programs you run in it read.",
		holds: () => true,
		title: "Environment"
	}
];

function draftFromValues(
	fields: readonly RuntimeConfigField[],
	values: Record<string, string>
): Record<string, string> {
	return Object.fromEntries(
		fields
			.filter((field) => !isSecretField(field))
			.map((field) => [
				field.key,
				values[field.key] ?? (field.kind === "boolean" ? "0" : "")
			])
	);
}

// What the whole form submits, in the shape `save` expects. Values the owner has
// not set are left out rather than sent empty: the server rejects an empty
// number instead of reading it as "unset", and an absent variable is what the
// box already treats as its default. A switch left off is absent for the same
// reason - the box enables a `COMPOSERY_DISABLE_*` surface only on an explicit
// 1, so writing a 0 would add a line that says nothing.
function buildConfig(
	fields: readonly RuntimeConfigField[],
	draft: Record<string, string>,
	secrets: Record<string, SecretIntent>
): Record<string, string> {
	const config: Record<string, string> = {};

	for (const field of fields) {
		if (isSecretField(field)) {
			const intent = secrets[field.key] ?? KEEP_SECRET;
			// `keep` submits nothing at all, which is how the server is told to
			// leave a value the page could not read back alone.
			if (intent.action === "set") config[field.key] = intent.value;
			if (intent.action === "clear") config[field.key] = "";
			continue;
		}

		const value = draft[field.key] ?? "";
		if (field.kind === "boolean") {
			if (value === "1") config[field.key] = "1";
			continue;
		}
		if (value !== "") config[field.key] = value;
	}

	return config;
}

// Every message `normalizeRuntimeConfig` throws opens with the offending
// variable's name and a space, so the server's own wording can be put under the
// field that caused it instead of only in a toast. The space is load-bearing:
// without it `HTTP_PROXY` would claim `HTTPS_PROXY`'s message. Anything that
// does not match stays a page-level error rather than being dropped.
function keyForError(
	fields: readonly RuntimeConfigField[],
	message: string
): string | null {
	return (
		fields.find((field) => message.startsWith(`${field.key} `))?.key ?? null
	);
}

export function BoxConfiguration({ boxId }: { boxId: string }) {
	const detail = useQuery(api.owner.boxes.getById, { boxId });
	const config = useQuery(
		api.owner.boxConfig.get,
		detail ? { slug: detail.box.slug } : "skip"
	);
	const saveConfig = useMutation(api.owner.boxConfig.save);
	const { busy, run } = useBusyAction();

	const [draft, setDraft] = useState<Record<string, string>>({});
	const [secrets, setSecrets] = useState<Record<string, SecretIntent>>({});
	const [saveError, setSaveError] = useState<string | null>(null);

	// Re-seed the form when the box's stored configuration changes - which is
	// what happens a few seconds after a save finishes applying. The secrets and
	// the last error go with it: they describe the configuration that was on
	// screen, and keeping them beside a newly arrived one would be reporting the
	// previous save's outcome about a value it no longer concerns.
	useReseed(
		config ? JSON.stringify([config.values, config.secretsSet]) : null,
		() => {
			if (!config) return;
			setDraft(draftFromValues(config.fields, config.values));
			setSecrets({});
			setSaveError(null);
		}
	);

	if (detail === undefined || config === undefined) return null;

	if (!detail || !config) {
		return (
			<Card>
				<CardContent>
					<p className="text-sm text-muted-foreground">Box not found.</p>
				</CardContent>
			</Card>
		);
	}

	const { box } = detail;
	const { canConfigure, fields } = config;
	const savedDraft = draftFromValues(fields, config.values);
	const dirty =
		Object.keys(savedDraft).some(
			(key) => (draft[key] ?? "") !== savedDraft[key]
		) || Object.values(secrets).some((intent) => intent.action !== "keep");

	const errorKey = saveError ? keyForError(fields, saveError) : null;
	const groups = GROUPS.map((group, index) => ({
		...group,
		fields: fields.filter(
			(field) =>
				GROUPS.findIndex((candidate) => candidate.holds(field)) === index
		)
	})).filter((group) => group.fields.length > 0);

	function save() {
		setSaveError(null);
		void run("config", "Applying configuration", async () => {
			try {
				await saveConfig({
					config: buildConfig(fields, draft, secrets),
					slug: box.slug
				});
			} catch (error) {
				// Rethrown so the toast still fires: the inline message is the useful
				// one, but a failure must never be reported only where the reader
				// might have scrolled past it.
				setSaveError(errorMessage(error));
				throw error;
			}
		});
	}

	function discard() {
		setDraft(savedDraft);
		setSecrets({});
		setSaveError(null);
	}
	return (
		<div className="space-y-4">
			<Notice muted tone="muted">
				<p className="font-medium text-foreground">The box password</p>
				<p className="mt-0.5">
					Removing it is not offered here: it would reopen the box on every
					boot, including the restarts a repair or an update causes. If you
					can&apos;t produce your password, change it from the{" "}
					<Link className="link" href={boxPath(boxId)}>
						box page
					</Link>{" "}
					instead.
				</p>
			</Notice>

			<p className="text-sm text-muted-foreground">
				See the{" "}
				<Link className="link" href="/docs/configuration">
					configuration reference
				</Link>{" "}
				for the variables this page does not offer.
			</p>

			{groups.map((group) => (
				<Card key={group.title}>
					<CardHeader>
						<CardTitle>{group.title}</CardTitle>
						<CardDescription>{group.description}</CardDescription>
					</CardHeader>
					<CardContent className="divide-y divide-border">
						{group.fields.map((field) =>
							isSecretField(field) ? (
								<SecretField
									disabled={!canConfigure || busy !== null}
									disabledReason={!canConfigure ? READ_ONLY_REASON : null}
									error={errorKey === field.key ? saveError : null}
									field={field}
									intent={secrets[field.key] ?? KEEP_SECRET}
									key={field.key}
									onIntentChange={(intent) =>
										setSecrets((current) => ({
											...current,
											[field.key]: intent
										}))
									}
									stored={config.secretsSet.includes(field.key)}
								/>
							) : (
								<ConfigField
									disabled={!canConfigure || busy !== null}
									disabledReason={!canConfigure ? READ_ONLY_REASON : null}
									error={errorKey === field.key ? saveError : null}
									field={field}
									key={field.key}
									onChange={(value) =>
										setDraft((current) => ({ ...current, [field.key]: value }))
									}
									slug={box.slug}
									value={draft[field.key] ?? ""}
								/>
							)
						)}
					</CardContent>
				</Card>
			))}

			{saveError && !errorKey ? (
				<Notice muted={false} tone="bad">
					{saveError}
				</Notice>
			) : null}

			{/* The one thing an owner must not be surprised by after pressing the
			    button, so it sits beside it. `applyRuntimeConfig` writes the env
			    file and runs `up -d --force-recreate`, so everything living inside
			    the container goes with it - the same cost the Update dialog names,
			    from the same sentence. */}
			<Notice muted={false} tone="warn">
				{recreateNotice("Saving")}
			</Notice>

			<div className="flex flex-wrap items-center justify-end gap-2">
				<Button
					disabled={!dirty || busy !== null}
					onClick={discard}
					variant="outline"
				>
					Discard changes
				</Button>
				<Tooltip>
					<TooltipTrigger render={<span className="inline-flex" />}>
						<AnimatedIconButton
							disabled={!canConfigure || !dirty || busy !== null}
							icon="check"
							iconPosition="start"
							onClick={save}
						>
							{busy === "config" ? "Saving…" : "Save changes"}
						</AnimatedIconButton>
					</TooltipTrigger>
					{!canConfigure ? (
						<TooltipContent>{READ_ONLY_REASON}</TooltipContent>
					) : null}
				</Tooltip>
			</div>
		</div>
	);
}
