// @vitest-environment jsdom

import { createElement, createRef, type HTMLAttributes } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const animation = vi.hoisted(() => ({
	start: vi.fn()
}));

vi.mock("motion/react", async () => {
	const { createElement, forwardRef } = await import("react");
	type MotionProps = HTMLAttributes<SVGElement> & {
		animate?: unknown;
		initial?: unknown;
		variants?: unknown;
	};
	const tags = new Proxy(
		{},
		{
			get: (_target, tag: string) =>
				forwardRef<SVGElement, MotionProps>(
					(
						{
							animate: _animate,
							initial: _initial,
							variants: _variants,
							...props
						},
						ref
					) => {
						void _animate;
						void _initial;
						void _variants;
						return createElement(tag, { ...props, ref });
					}
				)
		}
	);
	return {
		motion: tags,
		useAnimation: () => ({ start: animation.start })
	};
});

vi.mock("next/link", async () => {
	const { createElement, forwardRef } = await import("react");
	return {
		default: forwardRef<HTMLAnchorElement, HTMLAttributes<HTMLAnchorElement>>(
			(props, ref) => createElement("a", { ...props, ref })
		)
	};
});

vi.mock("@/components/base/button", () => import("@/tests/support/ui"));

import {
	AnimatedIcon,
	AnimatedIconAnchor,
	AnimatedIconButton,
	AnimatedIconLink,
	type AnimatedIconHandle,
	useAnimatedIconHandlers
} from "@/components/animated-icon";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("animated icons", () => {
	test("renders the named glyph with its requested position, size, and handle", () => {
		const iconRef = createRef<AnimatedIconHandle>();
		const view = render(
			createElement(AnimatedIcon, {
				className: "custom-icon",
				icon: "check",
				iconRef,
				position: "start",
				size: 22
			})
		);

		const icon = view.container.querySelector(".custom-icon");
		const svg = icon?.querySelector("svg");
		expect(icon?.classList.contains("size-4")).toBe(true);
		expect(icon?.getAttribute("data-icon")).toBe("inline-start");
		expect(svg?.getAttribute("height")).toBe("22");
		expect(svg?.getAttribute("width")).toBe("22");

		iconRef.current?.startAnimation();
		iconRef.current?.stopAnimation();
		expect(animation.start).toHaveBeenNthCalledWith(1, "animate");
		expect(animation.start).toHaveBeenNthCalledWith(2, "normal");

		view.rerender(
			createElement(AnimatedIcon, {
				className: "default-position",
				icon: "check",
				iconRef
			})
		);
		expect(
			view.container
				.querySelector(".default-position")
				?.getAttribute("data-icon")
		).toBeNull();
	});

	test("places link, anchor, and button glyphs around their labels", () => {
		const onLinkEnter = vi.fn();
		const onAnchorEnter = vi.fn();
		render(
			createElement(
				"div",
				null,
				createElement(
					AnimatedIconLink,
					{
						href: "/docs",
						icon: "check",
						iconPosition: "start",
						onMouseEnter: onLinkEnter
					},
					"Docs"
				),
				createElement(
					AnimatedIconAnchor,
					{
						href: "https://example.com",
						icon: "check",
						onMouseEnter: onAnchorEnter
					},
					"External"
				),
				createElement(AnimatedIconButton, { icon: "check" }, "Save")
			)
		);

		const docs = screen.getByRole("link", { name: "Docs" });
		const external = screen.getByRole("link", { name: "External" });
		const save = screen.getByRole("button", { name: "Save" });
		fireEvent.mouseEnter(docs);
		fireEvent.mouseEnter(external);
		expect(docs.firstElementChild?.getAttribute("data-icon")).toBe(
			"inline-start"
		);
		expect(docs.children).toHaveLength(1);
		expect(external.lastElementChild?.getAttribute("data-icon")).toBe(
			"inline-end"
		);
		expect(external.children).toHaveLength(1);
		expect(save.lastElementChild?.getAttribute("data-icon")).toBe("inline-end");
		expect(save.children).toHaveLength(1);
		expect(onLinkEnter).toHaveBeenCalledWith(
			expect.objectContaining({ target: docs })
		);
		expect(onAnchorEnter).toHaveBeenCalledWith(
			expect.objectContaining({ target: external })
		);
	});

	test("animates the glyph and forwards every interaction from its trigger", () => {
		const callbacks = {
			onBlur: vi.fn(),
			onFocus: vi.fn(),
			onMouseEnter: vi.fn(),
			onMouseLeave: vi.fn()
		};
		render(
			createElement(AnimatedIconButton, { ...callbacks, icon: "check" }, "Run")
		);
		const button = screen.getByRole("button", { name: "Run" });
		const matches = vi.spyOn(button, "matches").mockReturnValue(true);

		fireEvent.mouseEnter(button);
		fireEvent.mouseLeave(button);
		fireEvent.focus(button);
		fireEvent.blur(button);

		expect(animation.start.mock.calls).toEqual([
			["animate"],
			["normal"],
			["animate"],
			["normal"]
		]);
		matches.mockImplementationOnce(() => {
			throw new Error("unsupported selector");
		});
		fireEvent.focus(button);
		expect(animation.start).toHaveBeenCalledTimes(4);
		for (const callback of Object.values(callbacks)) {
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({ target: button })
			);
		}
	});

	test("ignores non-visible or unsupported focus without requiring an icon handle", () => {
		function BareTrigger() {
			const { handlers } = useAnimatedIconHandlers<HTMLButtonElement>({});
			return createElement("button", handlers, "Bare");
		}
		render(createElement(BareTrigger));
		const button = screen.getByRole("button", { name: "Bare" });
		const matches = vi.spyOn(button, "matches");

		matches.mockReturnValueOnce(false);
		fireEvent.focus(button);
		matches.mockImplementationOnce(() => {
			throw new Error("unsupported selector");
		});
		fireEvent.focus(button);
		matches.mockReturnValueOnce(true);
		fireEvent.focus(button);
		fireEvent.mouseEnter(button);
		fireEvent.mouseLeave(button);
		fireEvent.blur(button);

		expect(matches).toHaveBeenNthCalledWith(1, ":focus-visible");
		expect(matches).toHaveBeenNthCalledWith(2, ":focus-visible");
		expect(animation.start).not.toHaveBeenCalled();
	});
});
