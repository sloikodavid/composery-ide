// @vitest-environment jsdom

import { createElement } from "react";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() }
}));
vi.mock("@/components/animated-icon", () => import("@/tests/support/ui"));
vi.mock("@/components/base/button", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/base/input", () => import("@/tests/support/ui"));

import { ChangeSlugDialog } from "@/components/box/change-slug-dialog";

afterEach(cleanup);

describe("ChangeSlugDialog", () => {
	test("sanitizes and validates the slug before submitting the normalized value", async () => {
		let finish: (() => void) | undefined;
		const onSubmit = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const user = userEvent.setup();

		render(
			createElement(ChangeSlugDialog, {
				onSubmit,
				slug: "old-box"
			})
		);

		await user.click(screen.getByRole("button", { name: "Change slug" }));
		const dialog = screen.getByRole("dialog");
		const input = within(dialog).getByPlaceholderText("new-slug");
		const submit = within(dialog).getByRole("button", {
			name: "Change slug"
		});

		expect((submit as HTMLButtonElement).disabled).toBe(true);
		await user.type(input, "A!");
		expect((input as HTMLInputElement).value).toBe("a");
		expect((submit as HTMLButtonElement).disabled).toBe(true);

		await user.clear(input);
		await user.type(input, "My Box!!");
		expect((input as HTMLInputElement).value).toBe("mybox");
		expect((submit as HTMLButtonElement).disabled).toBe(false);

		await user.click(submit);
		expect(onSubmit).toHaveBeenCalledWith("mybox");
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("dialog")).not.toBeNull();

		finish?.();
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		await user.click(screen.getByRole("button", { name: "Change slug" }));
		expect(
			(
				within(screen.getByRole("dialog")).getByPlaceholderText(
					"new-slug"
				) as HTMLInputElement
			).value
		).toBe("");
	});
});
