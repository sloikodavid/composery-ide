"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { boxPath } from "@/convex/model/box/path";

// Where a customer coming back from Polar ends up. A completed payment is a
// redirect into the new box; a payment fulfillment refused is the one case that
// has to say something, because the page it lands on otherwise looks exactly
// like a checkout that never happened.
export function CheckoutRedirect({ checkoutId }: { checkoutId?: string }) {
	const router = useRouter();
	const checkout = useQuery(
		api.owner.checkout.completedCheckout,
		checkoutId ? { checkoutId } : "skip"
	);
	const outcome = checkout?.outcome;
	// The query is live, so this component re-renders on every change to the
	// reservation. Once told, stay told.
	const told = useRef(false);

	useEffect(() => {
		if (checkout?.boxId) router.replace(boxPath(checkout.boxId));
	}, [checkout?.boxId, router]);

	useEffect(() => {
		if (outcome !== "refunded" || told.current) return;
		told.current = true;
		toast.error("Your payment was refunded", {
			description:
				"The box could not be created, so the subscription was cancelled and the order refunded in full. Contact support if you were not refunded."
		});
	}, [outcome]);

	return null;
}
