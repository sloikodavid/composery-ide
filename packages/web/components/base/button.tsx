import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// `transition` (Tailwind's default property list), never `transition-all`:
// `all` includes the inherited `visibility`, and a visibility transition holds
// the old value for its whole duration. Any ancestor that hides itself with
// `visibility: hidden` - fumadocs' sidebar drawer once its slide-out animation
// ends and the transform snaps back - then leaves the button painted in place
// for 150ms with its container already gone, before it blinks out.
const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-2xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/60 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					"bg-primary-button text-primary-button-foreground hover:bg-primary-button-hover active:bg-primary-button-active",
				outline:
					"border-border bg-outline-button text-button-foreground hover:bg-outline-button-hover active:bg-outline-button-active aria-expanded:bg-outline-button-active aria-expanded:text-button-foreground",
				secondary:
					"bg-secondary-button text-secondary-button-foreground hover:bg-secondary-button-hover active:bg-secondary-button-active aria-expanded:bg-secondary-button-active aria-expanded:text-secondary-button-foreground",
				ghost:
					"hover:bg-hover hover:text-foreground focus-visible:bg-focus active:bg-focus aria-expanded:bg-focus aria-expanded:text-foreground",
				destructive:
					"bg-destructive/10 text-destructive hover:bg-destructive/16 active:bg-destructive/24 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/18 dark:hover:bg-destructive/26 dark:active:bg-destructive/34 dark:focus-visible:ring-destructive/40",
				warning:
					"bg-warning/10 text-warning hover:bg-warning/16 active:bg-warning/24 focus-visible:border-warning/40 focus-visible:ring-warning/20 dark:bg-warning/18 dark:hover:bg-warning/26 dark:active:bg-warning/34 dark:focus-visible:ring-warning/40",
				link: "link"
			},
			size: {
				default:
					"h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
				nav: "h-8 gap-1.5 rounded-full px-3",
				xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				lg: "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				icon: "size-8",
				"icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7",
				"icon-lg": "size-9"
			}
		},
		defaultVariants: {
			variant: "default",
			size: "default"
		}
	}
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
