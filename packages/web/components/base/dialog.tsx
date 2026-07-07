"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const dialogContentVariants = cva(
	"fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[min(var(--radius-4xl),24px)] bg-dialog p-6 text-dialog-foreground shadow-lg outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
	{
		variants: {
			size: {
				// Content-height dialog for confirmations and short forms.
				default: "grid max-w-md gap-4",
				// Wider view for fuller content (e.g. snapshots), still sized to its
				// content. Cap and scroll the long region inside the dialog, not here.
				panel: "grid max-w-3xl gap-4"
			}
		},
		defaultVariants: {
			size: "default"
		}
	}
);

function DialogContent({
	children,
	className,
	showClose = true,
	size,
	...props
}: DialogPrimitive.Popup.Props &
	VariantProps<typeof dialogContentVariants> & {
		showClose?: boolean;
	}) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-overlay data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(dialogContentVariants({ size }), className)}
				{...props}
			>
				{children}
				{showClose ? (
					<DialogPrimitive.Close
						aria-label="Close"
						className="absolute top-4 right-4 rounded-md text-muted-foreground opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-4"
					>
						<XIcon />
					</DialogPrimitive.Close>
				) : null}
			</DialogPrimitive.Popup>
		</DialogPrimitive.Portal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className
			)}
			{...props}
		/>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			className={cn("font-heading text-base font-medium", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger
};
