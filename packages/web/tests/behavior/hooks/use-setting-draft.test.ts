// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { useSettingDraft } from "@/hooks/use-setting-draft";

afterEach(cleanup);

describe("useSettingDraft", () => {
	test("waits for the server's value before calling anything dirty", () => {
		const { result, rerender } = renderHook(
			({ saved }: { saved?: Record<string, string> }) => useSettingDraft(saved),
			{ initialProps: {} as { saved?: Record<string, string> } }
		);

		expect(result.current.dirty).toBe(false);

		rerender({ saved: { limit: "3" } });
		expect(result.current.draft).toEqual({ limit: "3" });
		expect(result.current.dirty).toBe(false);
	});

	test("goes dirty on an edit and back when it is typed away again", () => {
		const { result } = renderHook(() => useSettingDraft({ limit: "3" }));

		act(() => result.current.setField("limit", "9"));
		expect(result.current.dirty).toBe(true);

		act(() => result.current.setField("limit", "3"));
		expect(result.current.dirty).toBe(false);
	});

	// The bug this exists for. The console's settings query also reports live
	// capacity, so it re-emits a fresh object whenever any box in the fleet
	// changes - and a panel that compared by identity wiped the field a staff
	// member was typing into every time an unrelated box started or stopped.
	test("keeps an unsaved edit when an equal value arrives as a new object", () => {
		const { result, rerender } = renderHook(
			({ saved }: { saved: Record<string, string> }) => useSettingDraft(saved),
			{ initialProps: { saved: { limit: "3" } } }
		);

		act(() => result.current.setField("limit", "42"));
		rerender({ saved: { limit: "3" } });

		expect(result.current.draft).toEqual({ limit: "42" });
		expect(result.current.dirty).toBe(true);
	});

	// The other half: a value that really did change - someone saved in another
	// tab, or the save this form just made came back - does re-seed the fields.
	test("re-seeds when the saved value actually changes", () => {
		const { result, rerender } = renderHook(
			({ saved }: { saved: Record<string, string> }) => useSettingDraft(saved),
			{ initialProps: { saved: { limit: "3" } } }
		);

		act(() => result.current.setField("limit", "42"));
		rerender({ saved: { limit: "7" } });

		expect(result.current.draft).toEqual({ limit: "7" });
		expect(result.current.dirty).toBe(false);
	});

	test("replaces every field at once for a reset to defaults", () => {
		const { result } = renderHook(() =>
			useSettingDraft({ manual: "30", automatic: "5" })
		);

		act(() => result.current.setDraft({ manual: "1", automatic: "1" }));
		expect(result.current.draft).toEqual({ manual: "1", automatic: "1" });
		expect(result.current.dirty).toBe(true);
	});
});
