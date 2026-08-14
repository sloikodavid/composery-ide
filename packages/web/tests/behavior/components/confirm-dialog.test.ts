// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/components/base/button", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));

import { ConfirmDialog } from "@/components/confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
	test("runs a destructive delete only after confirmation and stays open until it finishes", async () => {
		let finish: (() => void) | undefined;
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const user = userEvent.setup();

		render(
			// React's createElement type requires a required children prop here;
			// unlike JSX, its variadic children do not satisfy that component type.
			// eslint-disable-next-line react/no-children-prop
			createElement(ConfirmDialog, {
				children: (open) =>
					createElement("button", { onClick: open }, "Delete box"),
				confirmLabel: "Delete",
				description: "Deletes the box.",
				destructive: true,
				onConfirm,
				title: "Delete box"
			})
		);

		expect(onConfirm).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Delete box" }));
		expect(onConfirm).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledWith();
		expect(screen.getByRole("dialog")).not.toBeNull();

		finish?.();
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});
});
