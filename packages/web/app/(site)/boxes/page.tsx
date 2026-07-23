import { WashingMachineIcon } from "lucide-react";
import type { Metadata } from "next";
import { BoxList } from "./_components/box-list";
import { CheckoutRedirect } from "./_components/checkout-redirect";
import { AnimatedIconLink } from "@/components/animated-icon";
import { PageTemplate } from "@/components/page-template";
import { buttonVariants } from "@/components/base/button";
import { redirectIfSignedOut } from "@/lib/route-guards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Boxes"
};

export default async function BoxesPage({
	searchParams
}: {
	searchParams: Promise<{ checkout_id?: string }>;
}) {
	await redirectIfSignedOut("/boxes");
	const { checkout_id: checkoutId } = await searchParams;

	return (
		<PageTemplate
			actions={
				<AnimatedIconLink
					className={buttonVariants()}
					href="/pricing"
					icon="plus"
					iconPosition="start"
					prefetch={false}
				>
					New box
				</AnimatedIconLink>
			}
			breadcrumbs={[{ icon: WashingMachineIcon, label: "Boxes" }]}
		>
			<CheckoutRedirect checkoutId={checkoutId} />
			<BoxList />
		</PageTemplate>
	);
}
