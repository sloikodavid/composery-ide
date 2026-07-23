"use client";

import { type ReactNode, useState } from "react";
import { Button } from "@/components/base/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import { Input } from "@/components/base/input";
import { Label } from "@/components/base/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "@/components/base/select";
import { Textarea } from "@/components/base/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from "@/components/base/tooltip";
import type { RuntimeConfigField } from "@/convex/boxes/configuration";

type StringField = Extract<RuntimeConfigField, { kind: "string" }>;

// Both treatments come off the allowlist's own union rather than off a list of
// keys kept here, so a variable that arrives carrying `dangerous` or `secret`
// gets the treatment without this file changing. `in` rather than a plain read:
// the plain boolean variant does not declare `dangerous` at all.
export function isDangerousField(field: RuntimeConfigField) {
	return "dangerous" in field && field.dangerous === true;
}

export function isSecretField(field: RuntimeConfigField): field is StringField {
	return field.kind === "string" && field.secret === true;
}

// Anything longer than this gets a textarea. Keyed off the field's own limit so
// a new long value lands in the right control on its own.
const TEXTAREA_MIN_LENGTH = 513;

// What the form will do with one secret when it saves. `keep` is the default and
// the only one that submits nothing at all: `api.owner.boxConfig.save` reads a key
// missing from the payload as "leave it as it is", which is the only correct
// reading for a value the page was never sent. Sending the key with an empty
// string is the one way to remove it, and that is what `clear` does.
export type SecretIntent =
	{ action: "keep" } | { action: "set"; value: string } | { action: "clear" };

export const KEEP_SECRET: SecretIntent = { action: "keep" };

// A disabled control receives no pointer events, so the tooltip hangs off a
// span around it. The span mirrors the control's own width behaviour - fixed-
// width controls shrink-wrap, fill-width ones stretch under the same cap - so
// hovering exactly what is greyed out, and nothing more, explains why.
function DisabledTooltip({
	children,
	className,
	reason
}: {
	children: ReactNode;
	className: string;
	reason: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={<span className={className} />}>
				{children}
			</TooltipTrigger>
			<TooltipContent>{reason}</TooltipContent>
		</Tooltip>
	);
}

function FieldRow({
	children,
	error,
	field
}: {
	children: ReactNode;
	error: string | null;
	field: RuntimeConfigField;
}) {
	return (
		<div className="space-y-2 py-4 first:pt-0 last:pb-0">
			<div className="space-y-1">
				<Label htmlFor={field.key}>{field.key}</Label>
				<p className="text-sm text-pretty text-muted-foreground">
					{field.description}
				</p>
			</div>
			{children}
			{error ? <p className="text-sm text-destructive">{error}</p> : null}
		</div>
	);
}

// The typed box name, matching the Reset dialog. The description is the field's
// own sentence about what happens, because that sentence is the whole reason
// this dialog exists.
function DangerConfirm({
	confirmLabel,
	field,
	onConfirm,
	onOpenChange,
	open,
	slug
}: {
	confirmLabel: string;
	field: RuntimeConfigField;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	slug: string;
}) {
	const [confirmation, setConfirmation] = useState("");

	function changeOpen(nextOpen: boolean) {
		onOpenChange(nextOpen);
		if (!nextOpen) setConfirmation("");
	}

	return (
		<Dialog onOpenChange={changeOpen} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{field.key}</DialogTitle>
					<DialogDescription>{field.description}</DialogDescription>
				</DialogHeader>
				<p className="text-sm">
					Nothing changes until you save the whole page, and saving recreates
					the editor&apos;s container.
				</p>
				<Input
					autoCapitalize="none"
					autoComplete="off"
					onChange={(event) => setConfirmation(event.target.value)}
					placeholder={`Type ${slug} to confirm`}
					spellCheck={false}
					value={confirmation}
				/>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<Button
						disabled={confirmation !== slug}
						onClick={() => {
							onConfirm();
							changeOpen(false);
						}}
						variant="destructive"
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// One non-secret variable. Which control it gets is decided by `kind` alone, so
// a variable added to the allowlist renders here without this file changing.
export function ConfigField({
	disabled,
	disabledReason,
	error,
	field,
	onChange,
	slug,
	value
}: {
	disabled: boolean;
	// Why the box makes the field read-only, when it does. Shown as a tooltip
	// on the disabled control; null means the control is merely disabled for a
	// state the page already explains (a save in flight, a lock waiting on its
	// own confirmation).
	disabledReason: string | null;
	error: string | null;
	field: RuntimeConfigField;
	onChange: (value: string) => void;
	slug: string;
	value: string;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [unlocked, setUnlocked] = useState(false);

	const dangerous = isDangerousField(field);
	// A dangerous switch is guarded on the way on and never on the way off:
	// turning a protection back on must not need a ceremony. A dangerous value
	// has no "on", so its input stays locked until the same confirmation.
	const locked = dangerous && field.kind !== "boolean" && !unlocked;
	const controlDisabled = disabled || locked;

	function changeBoolean(next: string) {
		if (dangerous && next === "1" && value !== "1") {
			setConfirmOpen(true);
			return;
		}
		onChange(next);
	}

	let control: ReactNode;
	if (field.kind === "boolean") {
		control = (
			<Select
				disabled={controlDisabled}
				onValueChange={(next) => changeBoolean(next ?? "0")}
				value={value === "1" ? "1" : "0"}
			>
				<SelectTrigger className="w-32" id={field.key}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent alignItemWithTrigger={false}>
					<SelectItem value="0">Off</SelectItem>
					<SelectItem value="1">On</SelectItem>
				</SelectContent>
			</Select>
		);
	} else if (field.kind === "enum") {
		control = (
			<Select
				disabled={controlDisabled}
				onValueChange={(next) => onChange(next ?? "")}
				value={value}
			>
				<SelectTrigger className="w-40" id={field.key}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent alignItemWithTrigger={false}>
					{/* Empty is a real answer: the box has its own default for every
					    optional variable, and an owner must be able to go back to it. */}
					<SelectItem value="">Not set</SelectItem>
					{field.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	} else if (field.kind === "number") {
		control = (
			<Input
				className="w-40 tabular-nums"
				disabled={controlDisabled}
				id={field.key}
				max={field.max}
				min={field.min}
				onChange={(event) => onChange(event.target.value)}
				placeholder={`${field.min}-${field.max}`}
				type="number"
				value={value}
			/>
		);
	} else if (field.maxLength >= TEXTAREA_MIN_LENGTH) {
		control = (
			<Textarea
				autoCapitalize="none"
				autoComplete="off"
				className="font-mono text-xs"
				disabled={controlDisabled}
				id={field.key}
				maxLength={field.maxLength}
				onChange={(event) => onChange(event.target.value)}
				placeholder="Not set"
				spellCheck={false}
				value={value}
			/>
		);
	} else {
		control = (
			<Input
				autoCapitalize="none"
				autoComplete="off"
				className="max-w-md"
				disabled={controlDisabled}
				id={field.key}
				maxLength={field.maxLength}
				onChange={(event) => onChange(event.target.value)}
				placeholder="Not set"
				spellCheck={false}
				value={value}
			/>
		);
	}

	const wrapClass =
		field.kind === "boolean" || field.kind === "enum" || field.kind === "number"
			? "inline-flex"
			: field.maxLength >= TEXTAREA_MIN_LENGTH
				? "min-w-0 flex-1"
				: "min-w-0 flex-1 max-w-md";

	const wrapped =
		disabledReason && !locked ? (
			<DisabledTooltip className={wrapClass} reason={disabledReason}>
				{control}
			</DisabledTooltip>
		) : (
			control
		);

	return (
		<FieldRow error={error} field={field}>
			<div className="flex flex-wrap items-center gap-2">
				{wrapped}
				{locked && !disabled ? (
					<Button
						onClick={() => setConfirmOpen(true)}
						size="sm"
						variant="outline"
					>
						Unlock
					</Button>
				) : null}
			</div>
			{dangerous ? (
				<DangerConfirm
					confirmLabel={field.kind === "boolean" ? "Turn on" : "Unlock"}
					field={field}
					onConfirm={() =>
						field.kind === "boolean" ? onChange("1") : setUnlocked(true)
					}
					onOpenChange={setConfirmOpen}
					open={confirmOpen}
					slug={slug}
				/>
			) : null}
		</FieldRow>
	);
}

// One secret variable. The value is never rendered because the page is never
// sent it - `get` blanks secrets - so the input starts empty whether or not one
// is stored, and the placeholder is what says which. Typing replaces it; Clear
// is the only way to remove it.
export function SecretField({
	disabled,
	disabledReason,
	error,
	field,
	intent,
	onIntentChange,
	stored
}: {
	disabled: boolean;
	disabledReason: string | null;
	error: string | null;
	field: StringField;
	intent: SecretIntent;
	onIntentChange: (intent: SecretIntent) => void;
	stored: boolean;
}) {
	const input = (
		<Input
			autoCapitalize="none"
			autoComplete="off"
			className="max-w-md"
			disabled={disabled || intent.action === "clear"}
			id={field.key}
			maxLength={field.maxLength}
			onChange={(event) =>
				onIntentChange(
					event.target.value === ""
						? KEEP_SECRET
						: { action: "set", value: event.target.value }
				)
			}
			placeholder={stored ? "Leave blank to keep it" : "Not set"}
			spellCheck={false}
			type="password"
			value={intent.action === "set" ? intent.value : ""}
		/>
	);

	return (
		<FieldRow error={error} field={field}>
			<div className="flex flex-wrap items-center gap-2">
				{disabledReason ? (
					<DisabledTooltip
						className="min-w-0 flex-1 max-w-md"
						reason={disabledReason}
					>
						{input}
					</DisabledTooltip>
				) : (
					input
				)}
				{stored && !disabled ? (
					<Button
						onClick={() =>
							onIntentChange(
								intent.action === "clear" ? KEEP_SECRET : { action: "clear" }
							)
						}
						size="sm"
						variant={intent.action === "clear" ? "outline" : "destructive"}
					>
						{intent.action === "clear" ? "Keep it" : "Clear"}
					</Button>
				) : null}
			</div>
			{intent.action === "clear" ? (
				<p className="text-sm text-warning">
					This value is removed when you save.
				</p>
			) : null}
		</FieldRow>
	);
}
