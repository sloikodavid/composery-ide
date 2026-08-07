import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { signInUrlForReturnPath } from "@/lib/auth-routing";

export async function redirectIfSignedOut(returnPath: string) {
	const { isAuthenticated } = await auth();

	if (!isAuthenticated) {
		redirect(signInUrlForReturnPath(returnPath));
	}
}

export async function redirectIfSignedIn(destination: string) {
	const { isAuthenticated } = await auth();

	if (isAuthenticated) {
		redirect(destination);
	}
}

export async function notFoundIfNotStaff() {
	const { getToken, isAuthenticated } = await auth();

	if (!isAuthenticated) {
		notFound();
	}

	const token = await getToken({ template: "convex" });
	if (!token) {
		notFound();
	}

	const isStaff = await fetchQuery(
		api.owner.account.canAccessStaffConsole,
		{},
		{ token }
	);

	if (!isStaff) {
		notFound();
	}
}
