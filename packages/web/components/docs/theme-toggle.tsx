"use client";

// Adapted from fumadocs-ui 16.10.4 (dist/layouts/shared/slots/theme-switch.tsx),
// reduced to the light/dark pill we use (its three-way system mode is dropped).
// fumadocs no longer exports its layout slots, so reusing the source is the
// sanctioned path. Only the runtime deps changed: `useTranslations` -> a plain
// aria-label (we have no i18n provider) and `cn` -> our utils; the cva, classes,
// fd-* tokens, and behaviour are unchanged, so the pill stays 1:1 with the docs.

import { cva } from "class-variance-authority";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const itemVariants = cva("size-6.5 p-1.5 text-fd-muted-foreground", {
	variants: {
		active: {
			true: "bg-selected text-selected-foreground",
			false: "text-fd-muted-foreground"
		}
	}
});

const ITEMS = [
	["light", Sun],
	["dark", Moon]
] as const;

export function FumadocsThemeToggle({ className }: { className?: string }) {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- fumadocs' hydration guard, kept as-is
		setMounted(true);
	}, []);

	const value = mounted ? resolvedTheme : null;
	return (
		<button
			aria-label="Toggle Theme"
			className={cn(
				"inline-flex items-center overflow-hidden rounded-full border p-1 *:rounded-full",
				className
			)}
			data-theme-toggle=""
			onClick={() => setTheme(value === "light" ? "dark" : "light")}
			type="button"
		>
			{ITEMS.map(([key, Icon]) => (
				<Icon
					className={cn(itemVariants({ active: value === key }))}
					fill="currentColor"
					key={key}
				/>
			))}
		</button>
	);
}
