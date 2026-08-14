// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Every mutation and action the hook binds, recorded as (which function, which
// arguments). Nothing here reaches a backend: what this file is about is the
// binding - one slug, one busy name, one message - and a real Convex client would
// only put a transport between the assertion and the thing asserted.
const { calls, toasted } = vi.hoisted(() => ({
	calls: [] as { args: unknown; reference: unknown }[],
	toasted: [] as string[]
}));

vi.mock("convex/react", () => {
	const bind = (reference: unknown) => (args: unknown) => {
		calls.push({ args, reference });
		// The one call whose result is read. A same-document address, so jsdom
		// performs the navigation the hook asks for rather than refusing it.
		return Promise.resolve({ url: "#portal" });
	};
	return { useAction: bind, useMutation: bind };
});

vi.mock("sonner", () => ({
	toast: {
		error: (message: string) => toasted.push(message),
		success: (message: string) => toasted.push(message)
	}
}));

import { api } from "@/convex/_generated/api";
import { useBoxActions } from "@/hooks/use-box-actions";

const on = (reference: unknown, args: unknown = { slug: "my-box" }) => ({
	args,
	reference
});

beforeEach(() => {
	calls.length = 0;
	toasted.length = 0;
	window.location.hash = "";
});

afterEach(cleanup);

describe("useBoxActions", () => {
	test("binds every operation to the one box and reports it by name", async () => {
		const { result } = renderHook(() => useBoxActions("my-box"));

		await act(() => result.current.start());
		await act(() => result.current.stop());
		await act(() => result.current.retryCreate());
		await act(() => result.current.update());
		await act(() => result.current.repair());
		await act(() => result.current.reset());

		expect(calls).toEqual([
			on(api.owner.boxes.start),
			on(api.owner.boxes.stop),
			on(api.owner.boxes.retryCreate),
			on(api.owner.boxes.update),
			on(api.owner.boxes.repair),
			// The confirmation the mutation demands is the box's own slug, and the
			// dialog that collected it has already checked what was typed.
			on(api.owner.boxes.reset, { confirmation: "my-box", slug: "my-box" })
		]);
		expect(toasted).toEqual([
			"Starting box",
			"Stopping box",
			"Creating box",
			"Updating box",
			"Repairing box",
			"Resetting box"
		]);
	});

	// The two that report nothing here. A slug change is announced by the dialog
	// that owns it, and a repair check is a read - saying "done" about either
	// would be a second message about one action.
	test("says nothing for a slug change or a repair check", async () => {
		const { result } = renderHook(() => useBoxActions("my-box"));

		await act(() => result.current.changeSlug("other-box"));
		await act(() => result.current.checkRepair());

		expect(calls).toEqual([
			on(api.owner.boxes.changeSlug, {
				newSlug: "other-box",
				slug: "my-box"
			}),
			on(api.owner.boxes.recoveryStatus)
		]);
		expect(toasted).toEqual([]);
	});

	// Nothing has finished when the browser leaves for the payment provider, so
	// there is nothing to announce - only the address to follow.
	test("follows the payment provider's address without announcing it", async () => {
		const { result } = renderHook(() => useBoxActions("my-box"));

		await act(() => result.current.openBilling());

		expect(calls).toEqual([on(api.owner.boxes.customerPortalUrl)]);
		expect(window.location.hash).toBe("#portal");
		expect(toasted).toEqual([]);
	});

	test("names the running action, and clears the name when it finishes", async () => {
		const { result } = renderHook(() => useBoxActions("my-box"));

		expect(result.current.busy).toBeNull();
		let running: Promise<void> | undefined;
		act(() => {
			running = result.current.start();
		});
		expect(result.current.busy).toBe("start");

		await act(async () => {
			await running;
		});
		expect(result.current.busy).toBeNull();
	});
});
