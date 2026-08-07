import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { normalizeInternalReturnPath } from "@/lib/auth-routing";
import { signInAppearance } from "@/lib/clerk-appearance";
import { redirectIfSignedIn } from "@/lib/route-guards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Sign In"
};

export default async function SignInPage({
	searchParams
}: {
	searchParams: Promise<{ redirect_url?: string }>;
}) {
	// Somebody already signed in still goes where they were headed. Everything
	// that sends a visitor here - the pricing dialog carrying a plan and a slug,
	// the box authorization route mid-password-recovery - puts its destination on
	// `redirect_url`, and Clerk hands the same parameter back to itself after a
	// successful sign-in. Dropping it on the one path that skips the form would
	// throw the visitor's choices away exactly when nothing went wrong.
	const { redirect_url: redirectUrl } = await searchParams;
	await redirectIfSignedIn(normalizeInternalReturnPath(redirectUrl ?? "/"));

	return (
		<section className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-md items-center justify-center px-4">
			<div className="page-fade-in w-full">
				<SignIn
					appearance={signInAppearance}
					path="/sign-in"
					routing="path"
					withSignUp
				/>
			</div>
		</section>
	);
}
