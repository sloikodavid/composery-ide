"use client";

import type { ReactNode } from "react";
import {
	AnimatedIconButton,
	type AnimatedIconName
} from "@/components/animated-icon";
import { Input } from "@/components/base/input";

// The shell every staff settings panel wears: a card, a titled header carrying
// the action that commits it (and sometimes Reset), and stacked rows. Five
// panels drew all of that themselves, which is why no two of them agreed on the
// details.
//
// Deliberately only the shell. Each panel still lays out its own rows, because
// capacity's two-line descriptions, the thresholds' three-column responsive grid
// and the grant form's four-up inputs are real differences - a card that tried
// to own those would grow a prop per panel and stop being one thing.

export function SettingsCard({
	children,
	footnote,
	onReset,
	onSave,
	saveDisabled,
	// "Save" for a panel that edits a stored setting; a panel whose button does
	// something else says what, because a button labelled Save that provisions a
	// server is not telling the truth.
	saveIcon = "check",
	saveLabel = "Save",
	subtitle,
	title
}: {
	children: ReactNode;
	footnote?: ReactNode;
	onReset?: () => void;
	onSave: () => void;
	saveDisabled: boolean;
	saveIcon?: AnimatedIconName;
	saveLabel?: string;
	subtitle?: ReactNode;
	title: string;
}) {
	return (
		<div className="rounded-2xl bg-card">
			<div className="flex items-center justify-between px-4 py-3">
				<div>
					<h2 className="text-sm font-medium">{title}</h2>
					{subtitle ? (
						<p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
					) : null}
				</div>
				<div className="flex gap-2">
					{onReset ? (
						<AnimatedIconButton
							icon="rotate-cw"
							iconPosition="start"
							onClick={onReset}
							size="sm"
							variant="outline"
						>
							Reset
						</AnimatedIconButton>
					) : null}
					<AnimatedIconButton
						disabled={saveDisabled}
						icon={saveIcon}
						iconPosition="start"
						onClick={onSave}
						size="sm"
					>
						{saveLabel}
					</AnimatedIconButton>
				</div>
			</div>
			<div>{children}</div>
			{footnote ? (
				<p className="px-4 pb-3 text-xs text-pretty text-muted-foreground">
					{footnote}
				</p>
			) : null}
		</div>
	);
}

export function SettingsRow({
	children,
	label
}: {
	children: ReactNode;
	label: ReactNode;
}) {
	return (
		<div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
			{typeof label === "string" ? (
				<span className="text-sm">{label}</span>
			) : (
				label
			)}
			{children}
		</div>
	);
}

// A number beside the unit it is measured in. `tabular-nums` so a column of them
// does not jitter as digits change.
export function NumberField({
	disabled,
	inputClassName = "w-20",
	max,
	min,
	onChange,
	placeholder,
	unit,
	unitClassName = "w-20",
	value
}: {
	disabled?: boolean;
	inputClassName?: string;
	max?: number;
	min?: number;
	onChange: (value: string) => void;
	placeholder?: string;
	unit?: ReactNode;
	unitClassName?: string;
	value: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<Input
				className={`${inputClassName} tabular-nums`}
				disabled={disabled}
				max={max}
				min={min}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				type="number"
				value={value}
			/>
			{unit ? (
				<span
					className={`${unitClassName} shrink-0 text-xs text-muted-foreground`}
				>
					{unit}
				</span>
			) : null}
		</div>
	);
}
