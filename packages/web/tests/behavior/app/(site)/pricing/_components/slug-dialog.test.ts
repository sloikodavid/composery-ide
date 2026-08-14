// @vitest-environment jsdom

import { createElement } from "react";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

const convex = vi.hoisted(() => ({
	authenticationLoading: false,
	availability: undefined as
		{ available: boolean; resumable: boolean } | undefined,
	checkoutAvailability: undefined as
		{ available: boolean; message?: string } | undefined,
	createCheckout: vi.fn(
		() =>
			new Promise<{ checkoutUrl: string }>(() => {
				// Deliberately pending: the assertion is about the validated request
				// sent before navigation, not about browser navigation itself.
			})
	)
}));

vi.mock("@clerk/nextjs", () => ({
	useUser: () => ({ user: null })
}));
vi.mock("convex/react", () => ({
	useAction: () => convex.createCheckout,
	useConvexAuth: () => ({
		isAuthenticated: true,
		isLoading: convex.authenticationLoading
	}),
	useQuery: (_query: unknown, args: unknown) => {
		if (args === "skip") return undefined;
		if (
			typeof args === "object" &&
			args !== null &&
			Object.hasOwn(args, "slug")
		) {
			return convex.availability;
		}
		return convex.checkoutAvailability;
	}
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() }
}));
vi.mock("@/components/animated-icon", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/base/input", () => import("@/tests/support/ui"));
vi.mock("@/app/(site)/pricing/_components/fading-text", () => ({
	FadingText: ({ text }: { text: string }) => text
}));

import { SlugDialog } from "@/app/(site)/pricing/_components/slug-dialog";

afterEach(() => {
	cleanup();
	convex.createCheckout.mockClear();
	convex.authenticationLoading = false;
	convex.availability = undefined;
	convex.checkoutAvailability = undefined;
});

describe("SlugDialog", () => {
	test("submits only an available valid slug and sends the normalized checkout identity", async () => {
		const user = userEvent.setup();
		const view = render(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);

		const dialog = screen.getByRole("dialog");
		const input = within(dialog).getByRole("textbox", { name: "Box slug" });
		const submit = within(dialog).getByRole("button", {
			name: "Continue - Box Air"
		});

		expect(input.getAttribute("aria-invalid")).toBe("false");
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		await user.type(input, "A!");
		expect((input as HTMLInputElement).value).toBe("a");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		fireEvent.submit(submit.closest("form") as HTMLFormElement);
		expect(convex.createCheckout).not.toHaveBeenCalled();

		await user.clear(input);
		convex.checkoutAvailability = { available: true };
		await user.type(input, "My Box!!");
		expect((input as HTMLInputElement).value).toBe("mybox");
		expect(input.getAttribute("aria-invalid")).toBe("false");
		expect((submit as HTMLButtonElement).disabled).toBe(true);

		convex.availability = { available: false, resumable: false };
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect((submit as HTMLButtonElement).disabled).toBe(true);

		convex.availability = { available: true, resumable: false };
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect(input.getAttribute("aria-invalid")).toBe("false");
		expect((submit as HTMLButtonElement).disabled).toBe(false);

		convex.checkoutAvailability = {
			available: false,
			message: "Capacity exhausted"
		};
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		expect(within(dialog).getByText("Capacity exhausted")).not.toBeNull();

		convex.availability = { available: true, resumable: true };
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		expect(within(dialog).queryByText("Capacity exhausted")).toBeNull();

		convex.authenticationLoading = true;
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect((submit as HTMLButtonElement).disabled).toBe(true);

		convex.authenticationLoading = false;
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect((submit as HTMLButtonElement).disabled).toBe(false);

		await user.click(submit);
		expect(convex.createCheckout).toHaveBeenCalledWith({
			billingInterval: "month",
			plan: "air",
			slug: "mybox"
		});
		fireEvent.submit(submit.closest("form") as HTMLFormElement);
		expect(convex.createCheckout).toHaveBeenCalledTimes(1);
		expect((submit as HTMLButtonElement).disabled).toBe(true);
	});

	test("keeps the plan label on the submit button while the dialog closes", () => {
		const view = render(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "air"
			})
		);
		expect(
			screen.getByRole("button", { name: "Continue - Box Air" })
		).not.toBeNull();

		// Closing nulls the plan while the popup still plays its exit animation;
		// the label must not degrade to the plan-less fallback on screen.
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: null
			})
		);
		expect(
			screen.getByRole("button", { name: "Continue - Box Air" })
		).not.toBeNull();

		// Reopening for another plan moves the label with it.
		view.rerender(
			createElement(SlugDialog, {
				billingInterval: "month",
				initialSlug: "",
				onOpenChange: vi.fn(),
				plan: "pro"
			})
		);
		expect(
			screen.getByRole("button", { name: "Continue - Box Pro" })
		).not.toBeNull();
	});
});
