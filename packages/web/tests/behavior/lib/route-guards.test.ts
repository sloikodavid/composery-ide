import { beforeEach, describe, expect, test, vi } from "vitest";

// The gate in front of every server-rendered page, and the only thing between an
// ordinary signed-in account and the staff console. It is three separate refusals
// - not signed in, no Convex token, not staff - and all three answer `notFound`
// rather than a redirect or a 403, so the console does not confirm its own
// existence to somebody who may not have it.

const auth = vi.fn();
const redirect = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
	throw new Error("NOT_FOUND");
});
const fetchQuery = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: () => auth() }));
vi.mock("next/navigation", () => ({
	notFound: () => notFound(),
	redirect: (url: string) => redirect(url)
}));
vi.mock("convex/nextjs", () => ({
	fetchQuery: (...args: unknown[]) => fetchQuery(...args)
}));

const { notFoundIfNotStaff, redirectIfSignedIn, redirectIfSignedOut } =
	await import("@/lib/route-guards");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("pages that require a signed-in visitor", () => {
	test("sends a signed-out visitor to sign in, and back afterwards", async () => {
		auth.mockResolvedValue({ isAuthenticated: false });

		await expect(redirectIfSignedOut("/boxes/abc")).rejects.toThrow(
			"REDIRECT:"
		);

		// The return path travels with them, so signing in lands on the page they
		// asked for rather than on a dashboard they then have to navigate from.
		expect(redirect.mock.calls[0]?.[0]).toContain(
			encodeURIComponent("/boxes/abc")
		);
	});

	test("lets a signed-in visitor through untouched", async () => {
		auth.mockResolvedValue({ isAuthenticated: true });

		await expect(redirectIfSignedOut("/boxes")).resolves.toBeUndefined();
		expect(redirect).not.toHaveBeenCalled();
	});
});

describe("pages a signed-in visitor has no business on", () => {
	test("sends a signed-in visitor to where they meant to go", async () => {
		auth.mockResolvedValue({ isAuthenticated: true });

		await expect(redirectIfSignedIn("/boxes")).rejects.toThrow(
			"REDIRECT:/boxes"
		);
	});

	test("leaves a signed-out visitor on the sign-in page", async () => {
		auth.mockResolvedValue({ isAuthenticated: false });

		await expect(redirectIfSignedIn("/boxes")).resolves.toBeUndefined();
		expect(redirect).not.toHaveBeenCalled();
	});
});

// Three refusals, one answer. `notFound` rather than a redirect or a 403 is the
// point: an ordinary account probing /console learns nothing about whether the
// console exists.
describe("the staff console gate", () => {
	test("admits a staff account", async () => {
		auth.mockResolvedValue({
			isAuthenticated: true,
			getToken: vi.fn(async () => "token")
		});
		fetchQuery.mockResolvedValue(true);

		await expect(notFoundIfNotStaff()).resolves.toBeUndefined();
		expect(notFound).not.toHaveBeenCalled();
	});

	test("refuses a visitor who is not signed in", async () => {
		auth.mockResolvedValue({
			isAuthenticated: false,
			getToken: vi.fn(async () => "token")
		});

		await expect(notFoundIfNotStaff()).rejects.toThrow("NOT_FOUND");
		// Never asked, because there is nobody to ask about.
		expect(fetchQuery).not.toHaveBeenCalled();
	});

	// A Clerk session with no Convex token cannot be checked at all, and admitting
	// an unanswerable question is how an unauthenticated query reaches the console.
	test("refuses a session Convex cannot be asked about", async () => {
		auth.mockResolvedValue({
			isAuthenticated: true,
			getToken: vi.fn(async () => null)
		});

		await expect(notFoundIfNotStaff()).rejects.toThrow("NOT_FOUND");
		expect(fetchQuery).not.toHaveBeenCalled();
	});

	test("refuses a signed-in account that is not staff", async () => {
		auth.mockResolvedValue({
			isAuthenticated: true,
			getToken: vi.fn(async () => "token")
		});
		fetchQuery.mockResolvedValue(false);

		await expect(notFoundIfNotStaff()).rejects.toThrow("NOT_FOUND");
	});

	// The answer is Convex's, and it is asked as that visitor rather than as the
	// deployment - a query made without their token would answer about nobody.
	test("asks Convex as the visitor whose access is in question", async () => {
		const getToken = vi.fn(async () => "their-token");
		auth.mockResolvedValue({ isAuthenticated: true, getToken });
		fetchQuery.mockResolvedValue(true);

		await notFoundIfNotStaff();

		expect(getToken).toHaveBeenCalledWith({ template: "convex" });
		expect(fetchQuery.mock.calls[0]?.[2]).toEqual({ token: "their-token" });
	});
});
