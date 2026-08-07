"use client";

import { useEffect } from "react";
import { Button } from "@/components/base/button";
import { cn } from "@/lib/utils";
import { inter } from "./fonts";
import "./globals.css";

type GlobalErrorProps = {
	error: Error & { digest?: string };
	reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
	useEffect(() => {
		console.error(error);
	}, [error]);

	return (
		<html className={cn("antialiased", inter.variable)} lang="en">
			<body>
				<main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
					<section className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6">
						<div className="space-y-2">
							<h1 className="font-heading text-lg font-medium">
								Something went wrong
							</h1>
							<p className="text-sm leading-6 text-muted-foreground">
								The app failed to load. Try again, or come back in a moment.
							</p>
						</div>
						<Button onClick={reset}>Try again</Button>
					</section>
				</main>
			</body>
		</html>
	);
}
