"use client";

import { useUser } from "@clerk/nextjs";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { AnimatedIconButton } from "@/components/animated-icon";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import { Input } from "@/components/base/input";
import { api } from "@/convex/_generated/api";
import { FadingText } from "./fading-text";
import type { BoxBillingInterval } from "@/convex/model/box/billing";
import { BOX_PLANS, type BoxPlan } from "@/convex/model/box/plan";
import {
	isValidSlugFormat,
	sanitizeSlug,
	SLUG_MAX_LENGTH
} from "@/convex/model/box/slug";
import { errorMessage } from "@/lib/error-message";
import { signInUrlForReturnPath } from "@/lib/auth-routing";

// Naming the box, asked once and away from the cards.
//
// It used to be an input wired into each card beside a Checkout button, which
// made the slug look like part of choosing a plan - the field had to be answered
// before the card's button meant anything, and the same field appeared on every
// card so it was never clear which one it belonged to. Choosing a plan and
// naming the box are two decisions; the cards ask the first and this asks the
// second.
export function SlugDialog({
	billingInterval,
	initialSlug,
	onOpenChange,
	plan
}: {
	billingInterval: BoxBillingInterval;
	initialSlug: string;
	onOpenChange: (open: boolean) => void;
	// Null while closed. Carrying the plan on the open state rather than beside it
	// is what makes "which card did they press" unrepresentable as a mismatch.
	plan: BoxPlan | null;
}) {
	const createCheckout = useAction(api.owner.checkout.createCheckout);
	const { isAuthenticated, isLoading: authenticationLoading } = useConvexAuth();
	const { user } = useUser();
	// Clerk resolves after mount, so the suggestion is derived rather than seeded
	// into state; typing takes over from then on.
	const [typedSlug, setTypedSlug] = useState<string | null>(
		initialSlug || null
	);
	const [submitting, setSubmitting] = useState(false);
	// The plan the dialog was opened for, kept for the submit label. The open
	// state is the plan itself, so closing nulls it while the popup still plays
	// its exit animation; the label must not degrade to the plan-less fallback
	// while the dialog is still on screen.
	const [openedPlan, setOpenedPlan] = useState<BoxPlan | null>(plan);
	if (plan !== null && plan !== openedPlan) {
		setOpenedPlan(plan);
	}
	const suggestedSlug = sanitizeSlug(
		user?.username ??
			user?.primaryEmailAddress?.emailAddress.split("@")[0] ??
			""
	);
	// Checked before it's shown: landing on a prefilled slug that's already taken
	// reads as an error the visitor didn't cause, so an unavailable suggestion
	// just leaves the field empty.
	const suggestionAvailability = useQuery(
		api.owner.checkout.slugAvailability,
		typedSlug === null && isValidSlugFormat(suggestedSlug)
			? { slug: suggestedSlug }
			: "skip"
	);
	const slug =
		typedSlug ?? (suggestionAvailability?.available ? suggestedSlug : "");
	const normalizedSlug = sanitizeSlug(slug);
	const slugFormatValid = isValidSlugFormat(normalizedSlug);
	const availability = useQuery(
		api.owner.checkout.slugAvailability,
		slugFormatValid ? { slug: normalizedSlug } : "skip"
	);
	const checkoutAvailability = useQuery(api.owner.checkout.availability, {});
	const slugAvailable = availability?.available === true;
	const slugResumable = availability?.resumable === true;
	const checkoutAvailable = checkoutAvailability?.available === true;
	const slugVisuallyInvalid = normalizedSlug.length > 0 && !slugFormatValid;
	const slugTaken = slugFormatValid && availability != null && !slugAvailable;
	const canCheckout =
		!authenticationLoading &&
		slugFormatValid &&
		slugAvailable &&
		(checkoutAvailable || slugResumable);
	const checkoutUnavailable =
		checkoutAvailability?.available === false && !slugResumable;
	// A rejected slug already shows as a red field, so the only words here are for
	// the one state that isn't about the slug at all: no capacity for new boxes.
	const slugError = checkoutUnavailable
		? (checkoutAvailability.message ?? "Unavailable")
		: "";

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!plan || !canCheckout || submitting) return;

		if (!isAuthenticated) {
			// Everything the visitor has chosen so far rides through sign-in, so they
			// come back to the same plan, the same interval, and the same name rather
			// than to an empty pricing page.
			const query = new URLSearchParams({
				billing: billingInterval,
				plan,
				slug: normalizedSlug
			});
			window.location.assign(
				signInUrlForReturnPath(`/pricing?${query.toString()}`)
			);
			return;
		}

		setSubmitting(true);
		try {
			const checkout = await createCheckout({
				billingInterval,
				plan,
				slug: normalizedSlug
			});
			window.location.assign(checkout.checkoutUrl);
		} catch (error) {
			toast.error("Checkout could not start", {
				description: errorMessage(error)
			});
			setSubmitting(false);
		}
	}

	return (
		<Dialog onOpenChange={onOpenChange} open={plan !== null}>
			<DialogContent>
				<form className="grid gap-3" onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Name your box</DialogTitle>
						<DialogDescription>
							This is the address you&apos;ll open it at. You can change it
							later.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-1">
						<div className="flex min-h-3.5 items-center justify-end gap-3">
							<span
								aria-live="polite"
								className="min-w-0"
								id="box-slug-status"
								title={slugError || undefined}
							>
								<FadingText
									className="max-w-full truncate text-xs leading-none font-medium text-destructive"
									text={slugError}
								/>
							</span>
						</div>
						<Input
							aria-describedby="box-slug-status"
							aria-invalid={slugVisuallyInvalid || slugTaken}
							aria-label="Box slug"
							autoCapitalize="none"
							autoComplete="off"
							autoFocus
							className="h-9"
							id="box-slug"
							maxLength={SLUG_MAX_LENGTH}
							name="slug"
							onChange={(event) =>
								setTypedSlug(sanitizeSlug(event.target.value))
							}
							placeholder="my-box"
							spellCheck={false}
							type="text"
							value={slug}
						/>
					</div>

					<DialogFooter>
						<AnimatedIconButton
							className="w-full"
							disabled={!canCheckout || submitting}
							icon="arrow-right"
							size="lg"
							type="submit"
						>
							{openedPlan
								? `Continue - ${BOX_PLANS[openedPlan].label}`
								: "Continue"}
						</AnimatedIconButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
