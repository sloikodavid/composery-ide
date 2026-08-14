// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/components/base/dialog", () => import("@/tests/support/ui"));
vi.mock("@/components/base/dropdown-menu", () => import("@/tests/support/ui"));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) =>
		createElement("a", { href }, children)
}));
// Nothing in this file opens a dialog, so no query runs. The mock is what lets
// the dialogs' modules load without a Convex client under them.
vi.mock("convex/react", () => ({
	useAction: () => vi.fn(),
	useMutation: () => vi.fn(),
	useQuery: () => undefined
}));

import { BoxActionsMenu } from "@/components/box/actions-menu";
import type { Id } from "@/convex/_generated/dataModel";
import type { BoxStatus } from "@/convex/model/box/status";
import type { BoxActions } from "@/hooks/use-box-actions";
import type { BoxDetail, OwnerBox } from "@/lib/box/detail";

const BOX_ID = "box1" as Id<"boxes">;

const started = {
	changeSlug: vi.fn(),
	checkRepair: vi.fn(),
	openBilling: vi.fn(),
	repair: vi.fn(),
	reset: vi.fn(),
	retryCreate: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	update: vi.fn()
};

function actions(busy: string | null = null): BoxActions {
	return { busy, ...started } as unknown as BoxActions;
}

function box(status: BoxStatus = "running"): OwnerBox {
	return {
		comp: false,
		createdAt: 0,
		id: BOX_ID,
		plan: "pro",
		runtimeUrl: "https://my-box.example.com/",
		slug: "my-box",
		snapshots: { automatic: 4, manual: 1 },
		status
	};
}

// Only the three fields the menu reads. It takes the box page's detail whole, and
// standing up a payment provider's subscription object to prove that a menu item
// says "Update available" would be building the wrong thing.
const detail = {
	repair: null,
	runtime: {
		availableVersion: "0.2.1",
		comparable: true,
		currentVersion: "0.2.0",
		required: false,
		requiredBy: null,
		updateAvailable: true
	},
	subscription: null,
	update: null
} as unknown as BoxDetail;

// Every item the menu offers, in the order it offers them. Links count: an item
// that leaves the page is still an action the menu carries.
function items() {
	return [...screen.getByRole("menu").querySelectorAll("a, button")].map(
		(item) => item.textContent
	);
}

function item(name: string) {
	const found = items().indexOf(name);
	expect(found, `no menu item named ${name}`).toBeGreaterThanOrEqual(0);
	return screen.getByRole("menu").querySelectorAll("a, button")[found];
}

const trigger = createElement("button", { type: "button" }, "More");

afterEach(cleanup);

describe("BoxActionsMenu", () => {
	// The box page keeps the status action, connecting, updating and the plan on
	// buttons of their own, so its menu must not offer them a second time.
	test("offers only what the page beside it has no button for", () => {
		render(
			createElement(BoxActionsMenu, {
				actions: actions(),
				box: box(),
				detail,
				trigger
			})
		);

		expect(items()).toEqual([
			"Configuration",
			"Change password",
			"Change slug",
			"Snapshots",
			"Repair",
			"Reset"
		]);
	});

	// A list row has space for one button, so its menu is the whole box page's
	// action set in one place.
	test("offers every action a box page does when it is the only surface", () => {
		render(
			createElement(BoxActionsMenu, {
				actions: actions(),
				box: box(),
				detail,
				primary: true,
				trigger
			})
		);

		expect(items()).toEqual([
			"Stop",
			"Connect remotely",
			"Update available",
			"Copy link",
			"Show QR",
			"Configuration",
			"Change password",
			"Change slug",
			"Snapshots",
			"Box Pro - Billing date unavailable",
			"Repair",
			"Reset"
		]);
	});

	test("sends the items that leave the page to this box", () => {
		render(
			createElement(BoxActionsMenu, {
				actions: actions(),
				box: box(),
				detail,
				trigger
			})
		);

		expect(item("Configuration").getAttribute("href")).toBe(
			"/boxes/box1/configuration"
		);
		expect(item("Change password").getAttribute("href")).toBe(
			"https://my-box.example.com/change-password"
		);
	});

	// The same table the status button reads decides this, so the menu cannot
	// offer a stop the control plane would refuse - and a box that is off is not
	// a box anything can connect to.
	test("leads with the action this status leads with", async () => {
		const user = userEvent.setup();
		render(
			createElement(BoxActionsMenu, {
				actions: actions(),
				box: box("stopped"),
				detail,
				primary: true,
				trigger
			})
		);

		expect(items()[0]).toBe("Start");
		expect((item("Connect remotely") as HTMLButtonElement).disabled).toBe(true);

		await user.click(item("Start"));
		expect(started.start).toHaveBeenCalledWith();
	});

	// A row's detail arrives after its menu opens. Until it does, the items that
	// would have to describe it are refused rather than answered from nothing:
	// "Repair" beside an empty record reads as "nothing has ever gone wrong here".
	test("refuses the actions that describe a box it has not read yet", () => {
		render(
			createElement(BoxActionsMenu, {
				actions: actions(),
				box: box(),
				detail: undefined,
				primary: true,
				trigger
			})
		);

		for (const name of ["Update", "Billing", "Repair"]) {
			expect(
				(item(name) as HTMLButtonElement).disabled,
				`${name} is offered without a box to describe`
			).toBe(true);
		}
		expect(items()).toContain("Stop");
	});
});
