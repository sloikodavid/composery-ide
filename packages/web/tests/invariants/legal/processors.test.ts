import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The privacy policy has to name every third party we hand personal data to,
// and nothing derives that list - it is prose, written once, in a page nobody
// opens again after launch. The failure is silent and legal rather than
// technical: an integration ships, the setup doc for it is written, and the
// policy still describes a service that no longer exists in that shape.
//
// A service page under docs/developing/web/services/ is the mark of a third
// party that holds data for us: writing one is how an integration becomes real
// here. So the list of those files is the derived side, and this pins the prose
// to it. Duplication that cannot be removed - the policy is addressed to a
// reader, not assembled from a manifest - which is why it earns a test
// (see CLAUDE.md, "When one value ends up in two places").

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const SERVICE_DOCS = join(repoRoot, "docs/developing/web/services");
const PRIVACY_PAGE = join(repoRoot, "packages/web/app/(site)/privacy/page.tsx");

// Neither is a service: `index` is the section landing page and `meta` is
// fumadocs' ordering file.
const NOT_A_SERVICE = new Set(["index", "meta"]);

function servicesWithSetupDocs() {
	return readdirSync(SERVICE_DOCS)
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => basename(entry, ".md"))
		.filter((name) => !NOT_A_SERVICE.has(name));
}

describe("privacy policy processor list", () => {
	const services = servicesWithSetupDocs();
	const privacy = readFileSync(PRIVACY_PAGE, "utf8");

	test("finds the service docs (an empty list would pass the check below vacuously)", () => {
		expect(services).toEqual(
			expect.arrayContaining(["clerk", "polar", "resend"])
		);
		expect(services.length).toBeGreaterThan(4);
	});

	test.each(servicesWithSetupDocs())(
		"%s is named as a processor on the privacy page",
		(service) => {
			const name = service[0].toUpperCase() + service.slice(1);
			expect(privacy).toContain(name);
		}
	);

	// The one description this repository has already had to correct. Resend was
	// documented and disclosed as staff-only until owner notices shipped, and the
	// page said so for exactly as long as nobody re-read it against the code.
	test("does not describe Resend as staff-only while owners are emailed", () => {
		const emailsOwners = readFileSync(
			join(repoRoot, "packages/web/convex/notice/owner.ts"),
			"utf8"
		).includes("sendOwnerNotice");

		expect(emailsOwners).toBe(true);
		expect(privacy).not.toContain("Resend (staff-only");
	});
});
