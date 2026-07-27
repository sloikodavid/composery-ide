"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { Input } from "@/components/base/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "@/components/base/select";
import { api } from "@/convex/_generated/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import {
	BOX_PLANS,
	BOX_PLAN_ORDER,
	type BoxPlan
} from "@/convex/model/box/plan";
import { SettingsCard } from "./settings-card";

// Provision a box for an existing user without a paid checkout. The backend
// owns every guard (user exists, slug free, capacity, capability); this form
// only collects the inputs and reports the outcome.
//
// The plan is picked here and never changes by itself afterwards: a comp has no
// subscription, so nothing reconciles it. Staff move a comp between plans by
// resizing it from the box's own console page.
export function GrantBox() {
	const grantComp = useMutation(api.staff.boxes.grantComp);
	const { run, busy } = useBusyAction();
	const [email, setEmail] = useState("");
	const [slug, setSlug] = useState("");
	const [reason, setReason] = useState("");
	const [plan, setPlan] = useState<BoxPlan>("air");

	const ready =
		email.trim() !== "" && slug.trim() !== "" && reason.trim() !== "";

	return (
		<SettingsCard
			footnote="Provisions a real server against capacity, billed to no one. Recorded against your account."
			onSave={() =>
				run("grant-comp", "Box granted", async () => {
					await grantComp({
						email: email.trim(),
						plan,
						slug: slug.trim(),
						reason: reason.trim()
					});
					setEmail("");
					setSlug("");
					setReason("");
				})
			}
			saveDisabled={!ready || busy !== null}
			saveIcon="plus"
			saveLabel="Grant box"
			title="Grant a box"
		>
			<div className="grid gap-3 px-4 py-3 sm:grid-cols-4">
				<Select
					disabled={busy !== null}
					onValueChange={(value) => setPlan(value as BoxPlan)}
					value={plan}
				>
					<SelectTrigger aria-label="Plan" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{BOX_PLAN_ORDER.map((option) => (
							<SelectItem key={option} value={option}>
								{BOX_PLANS[option].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label="User email"
					disabled={busy !== null}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="User email"
					type="email"
					value={email}
				/>
				<Input
					aria-label="Box slug"
					disabled={busy !== null}
					onChange={(event) => setSlug(event.target.value)}
					placeholder="Box slug"
					value={slug}
				/>
				<Input
					aria-label="Reason"
					disabled={busy !== null}
					onChange={(event) => setReason(event.target.value)}
					placeholder="Reason (audited)"
					value={reason}
				/>
			</div>
		</SettingsCard>
	);
}
