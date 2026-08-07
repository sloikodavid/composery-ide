import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import {
	AnimatedIconLink,
	type AnimatedIconName
} from "@/components/animated-icon";

type Crumb = {
	href?: string;
	// Clickable crumbs take an @lucide-animated registry name so the icon runs
	// while the link is hovered; current-page crumbs are informational and take
	// a static lucide component.
	icon?: AnimatedIconName | ComponentType<{ className?: string }>;
	label: ReactNode;
};

type PageTemplateProps = {
	actions?: ReactNode;
	breadcrumbs: Crumb[];
	children?: ReactNode;
};

const CRUMB_LINK_CLASSES =
	"inline-flex items-center gap-1.5 text-muted-foreground no-underline transition-colors hover:text-foreground";
const CRUMB_PAGE_CLASSES = "inline-flex items-center gap-1.5";
const CRUMB_ICON_CLASSES = "size-5";

export function PageTemplate({
	actions,
	breadcrumbs,
	children
}: PageTemplateProps) {
	return (
		<div className="mx-auto max-w-5xl space-y-3.5">
			{/* min-h pins the row to the action buttons' height (h-8) even on
			    pages without actions, so content starts at the same place on
			    every page. */}
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
				<h1 className="flex flex-wrap items-center gap-1.5 text-lg font-medium text-foreground">
					{breadcrumbs.map((crumb, index) => {
						const iconName =
							typeof crumb.icon === "string" ? crumb.icon : undefined;
						const StaticIcon =
							typeof crumb.icon === "string" ? undefined : crumb.icon;
						const contents = (
							<>
								{StaticIcon ? (
									<StaticIcon className={CRUMB_ICON_CLASSES} />
								) : null}
								{crumb.label}
							</>
						);

						return (
							<span className="contents" key={`${crumb.label}-${index}`}>
								{index > 0 ? (
									<span aria-hidden="true" className="text-muted-foreground">
										/
									</span>
								) : null}

								{crumb.href ? (
									iconName ? (
										<AnimatedIconLink
											className={CRUMB_LINK_CLASSES}
											href={crumb.href}
											icon={iconName}
											iconClassName={CRUMB_ICON_CLASSES}
											iconPosition="start"
											iconSize={20}
										>
											{crumb.label}
										</AnimatedIconLink>
									) : (
										<Link className={CRUMB_LINK_CLASSES} href={crumb.href}>
											{contents}
										</Link>
									)
								) : (
									<span aria-current="page" className={CRUMB_PAGE_CLASSES}>
										{contents}
									</span>
								)}
							</span>
						);
					})}
				</h1>

				{/* Actions sit on the right of the breadcrumb row at every width -
			    flex-wrap drops them to their own line only when they genuinely
			    don't fit. Actions that want the whole width on a narrow screen
			    (a multi-button bar) say so themselves with `w-full sm:w-auto`;
			    PageTemplate doesn't decide that for them. */}
				{actions}
			</div>

			{children ? <div className="page-fade-in">{children}</div> : null}
		</div>
	);
}
