// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/components/base/button", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/box/status-button", () => import("@/tests/support/ui"));

import {
	BoxStatusAction,
	PRIMARY_ACTION
} from "@/components/box/status-action";
import {
	isOperationAllowed,
	type BoxOperationType
} from "@/convex/model/box/operation";
import type { BoxStatus } from "@/convex/model/box/status";

afterEach(cleanup);

function actions() {
	return {
		retry: { onClick: vi.fn() },
		start: { onClick: vi.fn() },
		stop: { onConfirm: vi.fn() },
		unsuspend: { onClick: vi.fn() }
	};
}

describe("BoxStatusAction", () => {
	test("requires confirmation before stopping a running box", async () => {
		const bound = actions();
		const user = userEvent.setup();
		render(
			createElement(BoxStatusAction, {
				...bound,
				status: "running"
			})
		);

		await user.click(screen.getByRole("button", { name: "Stop" }));
		expect(bound.stop.onConfirm).not.toHaveBeenCalled();
		await user.click(screen.getAllByRole("button", { name: "Stop" })[1]);
		expect(bound.stop.onConfirm).toHaveBeenCalledWith();
	});

	test("routes stopped, failed, and suspended states to their exact actions", async () => {
		const bound = actions();
		const user = userEvent.setup();
		const view = render(
			createElement(BoxStatusAction, {
				...bound,
				start: { ...bound.start, disabled: true },
				status: "stopped"
			})
		);
		expect(
			(screen.getByRole("button", { name: "Start" }) as HTMLButtonElement)
				.disabled
		).toBe(true);

		view.rerender(
			createElement(BoxStatusAction, {
				...bound,
				status: "create_failed"
			})
		);
		await user.click(screen.getByRole("button", { name: "Create again" }));
		expect(bound.retry.onClick).toHaveBeenCalledWith(
			expect.objectContaining({ type: "click" })
		);

		view.rerender(
			createElement(BoxStatusAction, {
				...bound,
				status: "suspended"
			})
		);
		await user.click(screen.getByRole("button", { name: "Unsuspend" }));
		expect(bound.unsuspend.onClick).toHaveBeenCalledWith(
			expect.objectContaining({ type: "click" })
		);

		view.rerender(
			createElement(BoxStatusAction, {
				retry: bound.retry,
				start: bound.start,
				status: "suspended",
				stop: bound.stop
			})
		);
		expect(
			(screen.getByRole("button", { name: "suspended" }) as HTMLButtonElement)
				.disabled
		).toBe(true);

		view.rerender(
			createElement(BoxStatusAction, {
				...bound,
				status: "repair_failed"
			})
		);
		expect(
			(
				screen.getByRole("button", {
					name: "repair_failed"
				}) as HTMLButtonElement
			).disabled
		).toBe(true);
	});
});

// The page and the control plane hold one rule between them: a button is only
// offered where the operation behind it may actually begin. `PRIMARY_ACTION` is
// what the component branches on, so this pins the page to the catalogue rather
// than to a copy of it - which is what the status literals it used to test were.
describe("the action a status leads with", () => {
	const rows = Object.entries(PRIMARY_ACTION) as [
		BoxStatus,
		BoxOperationType
	][];

	test("offers an action for every status that has one", () => {
		expect(rows.length).toBeGreaterThan(3);
	});

	test.each(rows)("%s offers %s, which is legal from it", (status, type) => {
		expect(isOperationAllowed(status, type)).toBe(true);
	});
});
