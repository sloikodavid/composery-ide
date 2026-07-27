"use client";

import type { ReactNode } from "react";
import { useState } from "react";
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
import { Label } from "@/components/base/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "@/components/base/select";
import { Textarea } from "@/components/base/textarea";

const SUSPENSION_REASONS: Array<{ label: string; reason: string }> = [
	{
		label: "Terms of service violation",
		reason: "Suspended for violating Composery's Terms of Service."
	},
	{
		label: "Billing issue",
		reason:
			"Suspended due to an unresolved billing issue with the subscription."
	},
	{
		label: "Security investigation",
		reason:
			"Suspended pending a security investigation into suspicious activity."
	},
	{
		label: "Abuse report",
		reason: "Suspended following a report of abusive or malicious use."
	},
	{
		label: "Account owner request",
		reason: "Suspended at the account owner's request."
	},
	{ label: "Other", reason: "" }
];

type SuspendTarget = {
	description: string;
	label: string;
	onConfirm: (reason: string) => void | Promise<void>;
};

export function SuspendDialog({
	children,
	targets
}: {
	children: (open: () => void) => ReactNode;
	targets: SuspendTarget[];
}) {
	const [open, setOpen] = useState(false);
	const [targetLabel, setTargetLabel] = useState(targets[0].label);
	const [category, setCategory] = useState(SUSPENSION_REASONS[0].label);
	const [reason, setReason] = useState(SUSPENSION_REASONS[0].reason);
	const target =
		targets.find((item) => item.label === targetLabel) ?? targets[0];
	const confirmLabel = `Suspend ${target.label.toLowerCase()}`;

	function pickCategory(label: string) {
		setCategory(label);
		const preset = SUSPENSION_REASONS.find((item) => item.label === label);
		setReason(preset?.reason ?? "");
	}

	return (
		<>
			{children(() => setOpen(true))}
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{confirmLabel}</DialogTitle>
						<DialogDescription>{target.description}</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						{targets.length > 1 ? (
							<div className="space-y-1.5">
								<Label>Target</Label>
								<Select
									onValueChange={(value) =>
										setTargetLabel(value ?? targets[0].label)
									}
									value={target.label}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent alignItemWithTrigger={false}>
										{targets.map((item) => (
											<SelectItem key={item.label} value={item.label}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						) : null}
						<div className="space-y-1.5">
							<Label>Reason</Label>
							<Select
								onValueChange={(value) => pickCategory(value ?? "")}
								value={category}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent alignItemWithTrigger={false}>
									{SUSPENSION_REASONS.map((item) => (
										<SelectItem key={item.label} value={item.label}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<Textarea
							onChange={(event) => setReason(event.target.value)}
							placeholder="This reason is recorded and shown to the account owner."
							value={reason}
						/>
					</div>
					<DialogFooter>
						<DialogClose render={<Button variant="outline">Cancel</Button>} />
						<Button
							disabled={!reason.trim()}
							onClick={async () => {
								await target.onConfirm(reason.trim());
								setOpen(false);
							}}
							variant="destructive"
						>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
