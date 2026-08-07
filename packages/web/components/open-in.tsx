"use client";

import type { VariantProps } from "class-variance-authority";
import { AnimatedIconAnchor } from "@/components/animated-icon";
import type { AnimatedIconName } from "@/components/animated-icon";
import { buttonVariants } from "@/components/base/button";
import {
	convexFilterUrl,
	convexTableUrl,
	hetznerServersUrl,
	hetznerServerUrl,
	polarCustomersUrl,
	polarCustomerUrl,
	polarSubscriptionUrl,
	vercelDashboardUrl,
	type VercelView
} from "@/lib/dashboards";
import { cn } from "@/lib/utils";

// Props every provider button shares. Each provider below only resolves an href
// and picks its icon/label; the icon-only vs labelled split lives in OpenIn once
// so it can't drift between them.
type OpenInProps = {
	className?: string;
	iconOnly?: boolean;
	label?: string;
	size?: VariantProps<typeof buttonVariants>["size"];
};

function OpenIn({
	className,
	href,
	icon,
	iconOnly = false,
	label,
	size = "sm"
}: OpenInProps & {
	href: string | null;
	icon: AnimatedIconName;
	label: string;
}) {
	if (!href) return null;

	if (iconOnly) {
		return (
			<AnimatedIconAnchor
				aria-label={label}
				className={cn(
					buttonVariants({ size: "icon-sm", variant: "ghost" }),
					className
				)}
				href={href}
				icon={icon}
				iconPosition="only"
				rel="noreferrer"
				target="_blank"
			/>
		);
	}

	return (
		<AnimatedIconAnchor
			className={cn(buttonVariants({ size, variant: "outline" }), className)}
			href={href}
			icon={icon}
			iconPosition="start"
			rel="noreferrer"
			target="_blank"
		>
			{label}
		</AnimatedIconAnchor>
	);
}

export function OpenInConvex({
	field,
	label = "Open in Convex",
	table,
	value,
	...props
}: OpenInProps & { field?: string; table: string; value?: string }) {
	return (
		<OpenIn
			{...props}
			href={
				value ? convexFilterUrl(table, value, field) : convexTableUrl(table)
			}
			icon="convex"
			label={label}
		/>
	);
}

export function OpenInHetzner({
	label = "Open in Hetzner",
	serverId,
	...props
}: OpenInProps & { serverId?: number | null }) {
	return (
		<OpenIn
			{...props}
			href={
				serverId === undefined
					? hetznerServersUrl()
					: hetznerServerUrl(serverId)
			}
			icon="hetzner"
			label={label}
		/>
	);
}

export function OpenInPolar({
	customerId,
	label = "Open in Polar",
	subscriptionId,
	...props
}: OpenInProps & {
	customerId?: string | null;
	subscriptionId?: string | null;
}) {
	const href =
		subscriptionId !== undefined
			? subscriptionId
				? polarSubscriptionUrl(subscriptionId)
				: null
			: customerId === undefined
				? polarCustomersUrl()
				: polarCustomerUrl(customerId);

	return <OpenIn {...props} href={href} icon="polar" label={label} />;
}

export function OpenInVercel({
	label = "Open in Vercel",
	view = "analytics",
	...props
}: OpenInProps & { view?: VercelView }) {
	return (
		<OpenIn
			{...props}
			href={vercelDashboardUrl(view)}
			icon="vercel"
			label={label}
		/>
	);
}
