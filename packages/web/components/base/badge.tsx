import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-2xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				default: "bg-badge text-badge-foreground [a]:hover:bg-badge-hover",
				secondary: "bg-badge text-badge-foreground [a]:hover:bg-badge-hover",
				destructive:
					"bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
				success:
					"bg-success/10 text-success dark:bg-success/18 [a]:hover:bg-success/20",
				warning:
					"bg-warning/10 text-warning dark:bg-warning/18 [a]:hover:bg-warning/20",
				outline: "border-border text-foreground [a]:hover:bg-hover",
				ghost: "hover:bg-hover hover:text-foreground",
				link: "link"
			}
		},
		defaultVariants: {
			variant: "default"
		}
	}
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className)
			},
			props
		),
		render,
		state: {
			slot: "badge",
			variant
		}
	});
}

export { Badge, badgeVariants };
