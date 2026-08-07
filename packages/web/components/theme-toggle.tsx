"use client";

import { useTheme } from "next-themes";
import { useRef } from "react";
import {
	AnimatedIcon,
	type AnimatedIconHandle
} from "@/components/animated-icon";
import { Button } from "@/components/base/button";

export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const iconRef = useRef<AnimatedIconHandle>(null);

	return (
		<Button
			aria-label="Toggle theme"
			onClick={() => {
				iconRef.current?.startAnimation();
				setTheme(resolvedTheme === "dark" ? "light" : "dark");
			}}
			size="icon"
			type="button"
			variant="ghost"
		>
			<AnimatedIcon icon="sun-moon" iconRef={iconRef} />
		</Button>
	);
}
