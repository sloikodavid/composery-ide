import { describe, expect, test } from "vitest";
import {
	CloudflareApiError,
	cloudflareErrorMessage,
	dnsRecordAction,
	dnsRecordListPath,
	dnsRecordPayload,
	isCloudflareNotFound
} from "@/convex/boxes/infra/cloudflareDns";

const record = (id: string, content: string) => ({
	id,
	type: "A",
	name: "atlas.example.com",
	content
});

describe("Cloudflare DNS requests", () => {
	test("uses an exact lookup before it changes a record", () => {
		const path = dnsRecordListPath("zone-123", "AAAA", "box.example.com");
		const query = new URLSearchParams(path.split("?")[1]);

		expect(path.startsWith("/zones/zone-123/dns_records?")).toBe(true);
		expect(Object.fromEntries(query)).toEqual({
			match: "all",
			"name.exact": "box.example.com",
			per_page: "100",
			type: "AAAA"
		});
	});

	test("keeps runtime records unproxied with automatic TTL", () => {
		expect(dnsRecordPayload("A", "box.example.com", "203.0.113.10")).toEqual({
			type: "A",
			name: "box.example.com",
			content: "203.0.113.10",
			ttl: 1,
			proxied: false
		});
	});
});

describe("reconciling one DNS name", () => {
	test("keeps the record that already has the address", () => {
		const live = record("live", "1.2.3.4");
		expect(
			dnsRecordAction([record("stale", "9.9.9.9"), live], "1.2.3.4")
		).toEqual({ type: "keep", record: live });
	});

	test("moves a stale record instead of adding a duplicate", () => {
		expect(dnsRecordAction([record("stale", "9.9.9.9")], "1.2.3.4")).toEqual({
			type: "update",
			id: "stale"
		});
	});

	test("creates a record only when the name has none", () => {
		expect(dnsRecordAction([], "1.2.3.4")).toEqual({ type: "create" });
	});
});

describe("Cloudflare failures", () => {
	test("reports every provider message", () => {
		expect(
			cloudflareErrorMessage(
				[{ message: "Invalid zone" }, { message: "Record exists" }],
				400
			)
		).toBe("Invalid zone; Record exists");
	});

	test("uses the status when the provider gives no message", () => {
		expect(cloudflareErrorMessage([], 502)).toBe("Cloudflare API 502.");
	});

	test("recognises only a Cloudflare 404 as missing", () => {
		expect(isCloudflareNotFound(new CloudflareApiError("gone", 404))).toBe(
			true
		);
		expect(isCloudflareNotFound(new CloudflareApiError("no", 403))).toBe(false);
		expect(isCloudflareNotFound(new Error("404"))).toBe(false);
	});
});
