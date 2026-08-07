"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ui } from "@clerk/ui";
import { Authenticated, ConvexReactClient, useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { clerkAppearance, clerkLocalization } from "@/lib/clerk-appearance";
import { nextEnv } from "@/lib/env";

const convexUrl = nextEnv.NEXT_PUBLIC_CONVEX_URL;

if (!convexUrl) {
	throw new Error("Missing NEXT_PUBLIC_CONVEX_URL in your environment.");
}

const convex = new ConvexReactClient(convexUrl);

export function Providers({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider
			appearance={clerkAppearance}
			localization={clerkLocalization}
			ui={ui}
		>
			<ConvexProviderWithClerk client={convex} useAuth={useAuth}>
				<Authenticated>
					<UserBootstrap />
				</Authenticated>
				{children}
			</ConvexProviderWithClerk>
		</ClerkProvider>
	);
}

function UserBootstrap() {
	const ensureCurrentUser = useMutation(api.owner.account.ensureCurrentUser);

	useEffect(() => {
		void ensureCurrentUser();
	}, [ensureCurrentUser]);

	return null;
}
