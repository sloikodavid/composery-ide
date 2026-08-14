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

vi.mock("@/components/animated-icon", () => import("@/tests/support/ui"));
vi.mock("@/components/base/button", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/base/input", () => import("@/tests/support/ui"));

import { ResetDialog } from "@/components/box/reset-dialog";

afterEach(cleanup);

describe("ResetDialog", () => {
	test("requires the exact slug and closes only after reset finishes", async () => {
		let finish: (() => void) | undefined;
		const onReset = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const user = userEvent.setup();

		const view = render(
			createElement(ResetDialog, {
				busy: null,
				onReset,
				slug: "my-box"
			})
		);

		await user.click(screen.getByRole("button", { name: "Reset" }));
		const dialog = screen.getByRole("dialog");
		const submit = within(dialog).getByRole("button", { name: "Reset" });
		const confirmation = within(dialog).getByPlaceholderText(
			"Type my-box to confirm"
		);

		expect((submit as HTMLButtonElement).disabled).toBe(true);
		await user.type(confirmation, "my-boxx");
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		await user.clear(confirmation);
		await user.type(confirmation, "my-box");
		expect((submit as HTMLButtonElement).disabled).toBe(false);

		await user.click(submit);
		expect(onReset).toHaveBeenCalledWith();
		expect(screen.getByRole("dialog")).not.toBeNull();

		finish?.();
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		await user.click(screen.getByRole("button", { name: "Reset" }));
		const reopened = screen.getByRole("dialog");
		const reopenedSubmit = within(reopened).getByRole("button", {
			name: "Reset"
		});
		expect(
			(
				within(reopened).getByPlaceholderText(
					"Type my-box to confirm"
				) as HTMLInputElement
			).value
		).toBe("");
		expect((reopenedSubmit as HTMLButtonElement).disabled).toBe(true);

		await user.type(
			within(reopened).getByPlaceholderText("Type my-box to confirm"),
			"my-box"
		);
		view.rerender(
			createElement(ResetDialog, {
				busy: "repair",
				onReset,
				slug: "my-box"
			})
		);
		expect((reopenedSubmit as HTMLButtonElement).disabled).toBe(true);
	});
});
