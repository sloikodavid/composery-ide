import { describe, expect, test } from "vitest";

import { findLoopbackCallbackTarget } from "../../../../../../../../../../overlay/lib/vscode/src/vs/workbench/contrib/url/browser/loopbackCallback.ts";

const target = (link: string) => findLoopbackCallbackTarget(link)?.origin;

describe("loopback callback links", () => {
	test("a redirect back to loopback is found and named by its origin", () => {
		expect(
			target(
				"https://accounts.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A9000%2Fcallback"
			)
		).toBe("http://localhost:9000");
	});

	// The parameter is spelled a different way by every provider, and a spelling
	// this misses is a link that opens and quietly never completes.
	test.each([
		"redirect_uri",
		"redirectUri",
		"Redirect-URI",
		"redirect_url",
		"redirectTo",
		"callback",
		"callback_url",
		"continue",
		"next",
		"return_to",
		"returnUrl",
		"destination",
		"post_logout_redirect_uri",
		"targetLinkUri"
	])("%s carries a callback", (param) => {
		expect(
			target(
				`https://idp.example.com/authorize?${param}=http://127.0.0.1:9000/cb`
			)
		).toBe("http://127.0.0.1:9000");
	});

	test("a parameter that is not a callback is not searched", () => {
		expect(
			target("https://example.com/?homepage=http://localhost:9000/")
		).toBeUndefined();
	});

	// Every way of writing "this machine" reaches the same interface, so every one
	// of them is the same problem. The IPv4-mapped IPv6 forms are the ones that
	// read as an ordinary address.
	test.each([
		["http://localhost:9000/cb", "http://localhost:9000"],
		["http://localhost.:9000/cb", "http://localhost.:9000"],
		["http://app.localhost:9000/cb", "http://app.localhost:9000"],
		["http://app.localhost.:9000/cb", "http://app.localhost.:9000"],
		["http://127.0.0.1:9000/cb", "http://127.0.0.1:9000"],
		["http://127.1.2.3:9000/cb", "http://127.1.2.3:9000"],
		["http://0.0.0.0:9000/cb", "http://0.0.0.0:9000"],
		["http://[::1]:9000/cb", "http://[::1]:9000"],
		["http://[::]:9000/cb", "http://[::]:9000"],
		["http://[::ffff:7f00:1]:9000/cb", "http://[::ffff:7f00:1]:9000"],
		["http://[::ffff:7fff:ffff]:9000/cb", "http://[::ffff:7fff:ffff]:9000"]
	])("%s is this machine", (callback, origin) => {
		expect(target(`https://idp.example.com/?redirect_uri=${callback}`)).toBe(
			origin
		);
	});

	test.each([
		"http://example.com:9000/cb",
		"http://128.0.0.1:9000/cb",
		"http://10.0.0.4:9000/cb",
		"http://notlocalhost:9000/cb",
		"http://localhostx:9000/cb",
		"http://[::ffff:8000:1]:9000/cb",
		"http://[::2]:9000/cb"
	])("%s is somewhere else", (callback) => {
		expect(
			target(`https://idp.example.com/?redirect_uri=${callback}`)
		).toBeUndefined();
	});

	// A single-page app keeps its parameters after the hash, in either shape.
	test("a callback in a hash query is still a callback", () => {
		expect(
			target(
				"https://idp.example.com/#/authorize?redirect_uri=http://localhost:9000/cb"
			)
		).toBe("http://localhost:9000");
	});

	test("a callback in a bare fragment is still a callback", () => {
		expect(
			target("https://idp.example.com/#redirect_uri=http://localhost:9000/cb")
		).toBe("http://localhost:9000");
	});

	// An ordinary fragment is a place in a document, not a query. The trailing "?"
	// is the awkward one: it looks like a hash query right up until there is
	// nothing after it.
	test.each([
		"https://idp.example.com/#section",
		"https://idp.example.com/#section?",
		"https://idp.example.com/#section?redirect_uri"
	])("%s carries no parameters", (link) => {
		expect(target(link)).toBeUndefined();
	});

	// One provider hands off to another, and the loopback address rides along in
	// the inner link.
	test("a callback nested two levels down is found", () => {
		const inner = encodeURIComponent(
			"https://idp.example.com/authorize?redirect_uri=http://localhost:9000/cb"
		);
		const outer = encodeURIComponent(
			`https://broker.example.com/start?redirect_uri=${inner}`
		);

		expect(target(`https://portal.example.com/go?next=${outer}`)).toBe(
			"http://localhost:9000"
		);
	});

	// The bound has to hold, because a link can carry itself: without it a chain
	// this long is a chain of any length.
	test("nesting past two levels is not followed", () => {
		const level = (inner: string) =>
			encodeURIComponent(`https://idp.example.com/?redirect_uri=${inner}`);

		expect(
			target(
				`https://portal.example.com/?next=${level(level(level("http://localhost:9000/cb")))}`
			)
		).toBeUndefined();
	});

	// The user asked for this address themselves; it is not a redirect landing
	// somewhere unexpected, and warning about it would be noise on every link.
	test("a link that is itself loopback is not a redirect problem", () => {
		expect(
			target("http://localhost:9000/?redirect_uri=http://localhost:9001/cb")
		).toBeUndefined();
	});

	test.each([
		[
			"mailto:someone@example.com?redirect_uri=http://localhost:9000/",
			"a non-http scheme"
		],
		["not a url at all", "unparseable text"],
		["", "an empty link"]
	])("%s carries nothing to guard (%s)", (link) => {
		expect(target(link)).toBeUndefined();
	});

	test("a callback parameter that is not an http url is ignored", () => {
		expect(
			target("https://idp.example.com/?redirect_uri=myapp://localhost/cb")
		).toBeUndefined();
		expect(target("https://idp.example.com/?redirect_uri=")).toBeUndefined();
	});
});
