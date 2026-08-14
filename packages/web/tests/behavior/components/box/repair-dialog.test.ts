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
import type { RecoveryStatus } from "@/convex/model/box/recovery";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() }
}));
vi.mock("@/components/animated-icon", () => import("@/tests/support/ui"));
vi.mock("@/components/base/badge", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/box/tone-icon", () => import("@/tests/support/ui"));

import { RepairDialog } from "@/components/box/repair-dialog";

const HEALTHY: RecoveryStatus = {
	hostReachable: true,
	httpReachable: true,
	engine: "copy",
	docker: "active",
	outerCaddy: "active",
	composery: "active",
	persistence: "active",
	caddy: "active",
	ide: "active"
};

afterEach(cleanup);

describe("RepairDialog", () => {
	test("does not probe or offer repair while the box is stopped", async () => {
		const check = vi.fn(async () => HEALTHY);
		const onRepair = vi.fn(async () => undefined);
		const user = userEvent.setup();

		render(
			createElement(RepairDialog, {
				boxStatus: "stopped",
				busy: null,
				check,
				onRepair,
				repair: null,
				slug: "my-box"
			})
		);

		await user.click(screen.getByRole("button", { name: "Repair" }));
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText(
				"This box is not running. Start it before repairing."
			)
		).not.toBeNull();
		expect(
			(
				within(dialog).getByRole("button", {
					name: "Repair"
				}) as HTMLButtonElement
			).disabled
		).toBe(true);
		expect(check).not.toHaveBeenCalled();
		expect(onRepair).not.toHaveBeenCalled();
	});

	test("probes a running box and offers repair after an honest healthy verdict", async () => {
		const check = vi.fn(async () => HEALTHY);
		const onRepair = vi.fn(async () => undefined);
		const user = userEvent.setup();

		const view = render(
			createElement(RepairDialog, {
				boxStatus: "running",
				busy: null,
				check,
				onRepair,
				repair: null,
				slug: "my-box"
			})
		);

		await user.click(screen.getByRole("button", { name: "Repair" }));
		const dialog = screen.getByRole("dialog");
		await waitFor(() => {
			expect(
				within(dialog).getByText("Everything looks healthy")
			).not.toBeNull();
		});
		expect(check).toHaveBeenCalledWith();

		view.rerender(
			createElement(RepairDialog, {
				boxStatus: "running",
				busy: "reset",
				check,
				onRepair,
				repair: null,
				slug: "my-box"
			})
		);
		expect(
			(
				within(dialog).getByRole("button", {
					name: "Repair"
				}) as HTMLButtonElement
			).disabled
		).toBe(true);

		view.rerender(
			createElement(RepairDialog, {
				boxStatus: "running",
				busy: null,
				check,
				onRepair,
				repair: null,
				slug: "my-box"
			})
		);
		await user.click(within(dialog).getByRole("button", { name: "Repair" }));
		expect(onRepair).toHaveBeenCalledWith();
	});

	test("keeps the repair action disabled while a repair operation is pending", async () => {
		const user = userEvent.setup();
		const view = render(
			createElement(RepairDialog, {
				boxStatus: "repairing",
				busy: null,
				check: vi.fn(async () => HEALTHY),
				onRepair: vi.fn(async () => undefined),
				repair: {
					error: null,
					finishedAt: null,
					status: "pending"
				},
				slug: "my-box"
			})
		);

		await user.click(screen.getByRole("button", { name: "Repair" }));
		const action = within(screen.getByRole("dialog")).getByRole("button", {
			name: "Repairing…"
		});
		expect((action as HTMLButtonElement).disabled).toBe(true);

		view.rerender(
			createElement(RepairDialog, {
				boxStatus: "repairing",
				busy: null,
				check: vi.fn(async () => HEALTHY),
				onRepair: vi.fn(async () => undefined),
				repair: {
					error: null,
					finishedAt: null,
					status: "running"
				},
				slug: "my-box"
			})
		);
		expect(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Repairing…"
			})
		).not.toBeNull();
	});
});
