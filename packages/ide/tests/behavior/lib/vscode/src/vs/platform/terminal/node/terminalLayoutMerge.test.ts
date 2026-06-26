import { describe, expect, test } from "vitest";

import { mergeTerminalLayouts } from "../../../../../../../../../overlay/lib/vscode/src/vs/platform/terminal/node/terminalLayoutMerge.ts";

const visible = { shellLaunchConfig: {} };
const hidden = { shellLaunchConfig: { hideFromUser: true } };

const tab = (...ids: number[]) => ({
	isActive: false,
	activePersistentProcessId: ids[0] ?? undefined,
	terminals: ids.map((terminal) => ({ terminal, relativeSize: 1 }))
});

const layoutOf = (
	tabs: ReturnType<typeof tab>[],
	background: number[] | null = null
) => ({ workspaceId: "w", tabs, background });

describe("terminal layout merge", () => {
	test("a candidate the client already placed is left where it is", () => {
		const merged = mergeTerminalLayouts("w", layoutOf([tab(1, 2)]), [
			[1, visible],
			[2, visible]
		]);

		expect(merged).toEqual(layoutOf([tab(1, 2)], []));
	});

	test("a candidate the client has never seen is appended as its own tab", () => {
		const merged = mergeTerminalLayouts("w", layoutOf([tab(1)]), [
			[1, visible],
			[2, visible]
		]);

		expect(merged?.tabs).toEqual([tab(1), tab(2)]);
		expect(merged?.background).toEqual([]);
	});

	test("a hidden candidate joins the background instead of the tabs", () => {
		const merged = mergeTerminalLayouts("w", undefined, [
			[1, hidden],
			[2, visible]
		]);

		expect(merged?.background).toEqual([1]);
		expect(merged?.tabs).toEqual([tab(2)]);
	});

	// A terminal named in the client's background is already accounted for, so a
	// second entry would have the pty host expand the same pty twice.
	test("a candidate the client backgrounded is not added a second time", () => {
		const merged = mergeTerminalLayouts("w", layoutOf([], [7]), [[7, hidden]]);

		expect(merged?.background).toEqual([7]);
		expect(merged?.tabs).toEqual([]);
	});

	// The caller hands over the layout it also keeps as this client's last known
	// one, so a merge that wrote through would rewrite history: the stored layout
	// would grow every terminal the client was ever shown and stop reflecting what
	// it reported.
	test("the client's own layout is left untouched", () => {
		const stored = layoutOf([tab(1)], [5]);

		mergeTerminalLayouts("w", stored, [
			[1, visible],
			[2, visible],
			[3, hidden]
		]);

		expect(stored).toEqual(layoutOf([tab(1)], [5]));
	});

	// Upstream reads undefined as "this client has never reported a layout" and an
	// empty layout as "it reported having no terminals". Answering with the wrong
	// one of those either restores nothing on a fresh client or discards the
	// session on a returning one, so the distinction survives the merge.
	test("nothing stored and nothing to adopt stays undefined", () => {
		expect(mergeTerminalLayouts("w", undefined, [])).toBeUndefined();
	});

	test("a stored empty layout stays an empty layout", () => {
		expect(mergeTerminalLayouts("w", layoutOf([]), [])).toEqual(
			layoutOf([], [])
		);
	});

	test("a client with no layout of its own is given the terminals it can adopt", () => {
		const merged = mergeTerminalLayouts("w", undefined, [[4, visible]]);

		expect(merged).toEqual(layoutOf([tab(4)], []));
	});

	test("the answer is filed under the workspace that was asked about", () => {
		expect(mergeTerminalLayouts("other", undefined, [[1, visible]])).toEqual({
			workspaceId: "other",
			tabs: [tab(1)],
			background: []
		});
	});
});
