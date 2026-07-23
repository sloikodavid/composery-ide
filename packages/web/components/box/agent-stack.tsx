"use client";

import { useEffect, useState } from "react";

import { ClaudeLogo } from "@/components/icons/claude-logo";
import { OpenAILogo } from "@/components/icons/openai-logo";
import { cn } from "@/lib/utils";

// One agent at a time, cross-fading.
//
// Two logos side by side had to be shrunk to fit a button, and shrinking the
// artwork is what stops it identifying anything. One at a time keeps each at the
// size every other button icon uses, and the fade says "and the other one"
// without spending any width saying it.
//
// Exactly these two, and not as a shortlist: Claude Desktop and ChatGPT Desktop
// are the two applications that can currently take an SSH host and work inside
// it. Anything that speaks SSH reaches a box - a terminal, Cursor, a desktop
// editor's remote mode - but those two are the ones whose own interface has a
// place to put a host, so they are the two the button shows and the two the
// documentation walks through.
//
// Each keeps its own colour rule rather than being tinted to one: Claude's is the
// terracotta, and OpenAI's is monochrome by design, so `currentColor` there is
// what renders it correctly rather than what avoids deciding.
const AGENTS = [
	{ Logo: OpenAILogo, name: "OpenAI" },
	{ Logo: ClaudeLogo, name: "Claude" }
];

// Long enough to read as a deliberate change rather than a flicker, and slow
// enough that a button sitting on screen is not asking for attention.
const HOLD_MS = 3200;

export function AgentStack({ className }: { className?: string }) {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const timer = setInterval(
			() => setIndex((current) => (current + 1) % AGENTS.length),
			HOLD_MS
		);
		return () => clearInterval(timer);
	}, []);

	return (
		<span
			// One accessible name for the pair, because a screen reader should hear
			// what the button connects to, not whichever logo the timer landed on.
			aria-label="OpenAI and Claude"
			// The button tightens its leading padding for an icon; this is one.
			className={cn("relative block size-4 shrink-0", className)}
			data-icon="inline-start"
			role="img"
		>
			{AGENTS.map(({ Logo, name }, position) => (
				<Logo
					className={cn(
						"absolute inset-0 size-4 transition-opacity duration-700 motion-reduce:transition-none",
						position === index ? "opacity-100" : "opacity-0"
					)}
					key={name}
				/>
			))}
		</span>
	);
}
