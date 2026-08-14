import { describe, expect, test } from "vitest";
import {
	LEGAL_NOTICES,
	LEGAL_VERSION,
	LEGAL_VERSIONS,
	legalUpdatedLabel
} from "@/convex/model/legal";

// Changing the legal documents and telling customers you changed them are one
// act, and this is what makes them one act.
//
// Nothing derives a notice from a revision - the notice is prose, written for a
// reader, and no generator can decide what a change means to them. So the two
// are separate declarations that must agree, which is duplication that cannot be
// removed and therefore earns a test (see CLAUDE.md, "When one value ends up in
// two places"). What it buys is that the obligation is discharged by the type
// checker's schedule rather than by anyone's memory: under Article 19 of
// Directive (EU) 2019/770 an unannounced modification is not a modification the
// trader may rely on, and the moment someone is most likely to forget is the
// moment they are absorbed in getting the wording of the change right.
//
// The rule has no exceptions. The first version is unannounced because it
// supersedes nothing, which is a property of being first rather than a licence
// granted to it - so the rule reads "every version with a predecessor", and
// there is no list of versions excused from it.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function announcedVersions() {
	return LEGAL_NOTICES.map((notice) => notice.version).filter(
		(version) => version !== undefined
	);
}

describe("legal document versions", () => {
	test("are ISO dates in ascending order, with no duplicates", () => {
		expect(LEGAL_VERSIONS.length).toBeGreaterThan(0);
		for (const version of LEGAL_VERSIONS) {
			expect(version, `${version} is not an ISO date`).toMatch(ISO_DATE);
			expect(
				Number.isNaN(Date.parse(`${version}T00:00:00Z`)),
				`${version} is not a real date`
			).toBe(false);
		}
		expect([...LEGAL_VERSIONS]).toEqual([...new Set(LEGAL_VERSIONS)]);
		expect([...LEGAL_VERSIONS]).toEqual([...LEGAL_VERSIONS].sort());
	});

	test("end at the version the pages print and orders record", () => {
		expect(LEGAL_VERSION).toBe(LEGAL_VERSIONS[LEGAL_VERSIONS.length - 1]);
	});

	// A version that does not parse renders "Invalid Date" on the Terms, Privacy
	// and Cookie pages at once, and on nothing else - so no other check would
	// catch it, and the pages themselves are the last place anyone looks.
	test("render as a readable date", () => {
		expect(legalUpdatedLabel()).toMatch(/^\d{1,2} \w+ \d{4}$/);
	});
});

describe("account notices", () => {
	test("have unique ids and say something", () => {
		const ids = LEGAL_NOTICES.map((notice) => notice.id);
		expect(ids).toEqual([...new Set(ids)]);
		for (const notice of LEGAL_NOTICES) {
			expect(notice.id.trim()).not.toBe("");
			expect(notice.subject.trim()).not.toBe("");
			expect(notice.text.trim()).not.toBe("");
		}
	});

	test("announce a declared version, where they announce one", () => {
		for (const version of announcedVersions()) {
			expect(
				LEGAL_VERSIONS as readonly string[],
				`notice announces ${version}, which is not a declared legal version`
			).toContain(version);
		}
	});

	test("announce each version at most once", () => {
		const announced = announcedVersions();
		expect(announced).toEqual([...new Set(announced)]);
	});

	// The binding this file exists for.
	test.each(LEGAL_VERSIONS.slice(1))(
		"version %s was announced to existing customers",
		(version) => {
			expect(
				announcedVersions(),
				`No entry in LEGAL_NOTICES announces ${version}. A revision of the legal documents that nobody was told about is not one Composery may rely on - see convex/model/legal.ts.`
			).toContain(version);
		}
	);
});
