import { cloneElement, useEffect, useState } from "react";
import type { ComponentProps, PropsWithChildren, ReactElement } from "react";

// Base UI keeps the popup mounted while its exit animation plays, so a closing
// dialog still shows its content. The timer models that window; without it, a
// close looks instant and nothing can test what a dialog shows as it leaves.
export function Dialog({
	children,
	open
}: PropsWithChildren<{ open: boolean }>) {
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			setMounted(true);
		} else {
			const timer = setTimeout(() => setMounted(false), 150);
			return () => clearTimeout(timer);
		}
	}, [open]);
	return mounted ? <div role="dialog">{children}</div> : null;
}

export function DialogClose({ render }: { render: ReactElement }) {
	return render;
}

export function DialogContent({ children }: PropsWithChildren) {
	return <div>{children}</div>;
}

export function DialogDescription({ children }: PropsWithChildren) {
	return <p>{children}</p>;
}

export function DialogFooter({ children }: PropsWithChildren) {
	return <div>{children}</div>;
}

export function DialogHeader({ children }: PropsWithChildren) {
	return <div>{children}</div>;
}

export function DialogTitle({ children }: PropsWithChildren) {
	return <h2>{children}</h2>;
}

export function Button({
	size: _size,
	variant: _variant,
	...props
}: ComponentProps<"button"> & { size?: string; variant?: string }) {
	void _size;
	void _variant;
	return <button {...props} />;
}

export function AnimatedIconButton({
	icon: _icon,
	iconPosition: _iconPosition,
	size: _size,
	variant: _variant,
	...props
}: ComponentProps<"button"> & {
	icon: string;
	iconPosition?: string;
	size?: string;
	variant?: string;
}) {
	void _icon;
	void _iconPosition;
	void _size;
	void _variant;
	return <button {...props} />;
}

export function Input(props: ComponentProps<"input">) {
	return <input {...props} />;
}

export function Badge({ children }: PropsWithChildren<{ variant?: string }>) {
	return <span>{children}</span>;
}

export function ToneIcon({ tone }: { tone: string }) {
	return <span data-tone={tone} />;
}

// The dropdown, with its popup always open. Base UI mounts the real one into a
// portal it positions, and none of that is what a menu's items are asserted
// against - which items it offers, which of them are refused, and where the ones
// that leave the page go.
export function DropdownMenu({ children }: PropsWithChildren) {
	return <div>{children}</div>;
}

export function DropdownMenuTrigger({ render }: { render: ReactElement }) {
	return render;
}

export function DropdownMenuContent({ children }: PropsWithChildren) {
	return <div role="menu">{children}</div>;
}

// `render` is how an item becomes a link, so it is honoured rather than dropped:
// an item that leaves the page is asserted by its destination.
export function DropdownMenuItem({
	children,
	disabled,
	onClick,
	render
}: PropsWithChildren<{
	disabled?: boolean;
	onClick?: () => void;
	render?: ReactElement;
	variant?: string;
}>) {
	if (render) return cloneElement(render, {}, children);
	return (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	);
}

export function DropdownMenuSeparator() {
	return <div role="separator" />;
}

export function StatusButton({
	action,
	status
}: {
	action?: {
		disabled?: boolean;
		label: string;
		onClick: () => void;
	};
	status: string;
}) {
	return (
		<button
			disabled={action ? action.disabled : true}
			onClick={action?.onClick}
		>
			{action?.label ?? status}
		</button>
	);
}
