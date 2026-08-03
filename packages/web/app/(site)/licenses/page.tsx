import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { GITHUB_REPO_URL } from "@/convex/model/links";

export const metadata: Metadata = { title: "Licences" };

export default function LicensesPage() {
	return (
		<LegalPage title="Licences">
			<LegalSection title="Composery source code">
				<p>
					Composery&apos;s original source code is available under the Apache
					License, Version 2.0. The full licence and copyright notice are
					included in the{" "}
					<a
						className="link"
						href={GITHUB_REPO_URL + "/blob/main/LICENSE"}
						rel="noreferrer"
						target="_blank"
					>
						repository LICENSE file
					</a>
					. The licence does not grant rights to Composery trademarks or
					branding.
				</p>
			</LegalSection>
			<LegalSection title="Upstream and third-party software">
				<p>
					The distribution builds on upstream and third-party software that
					stays under its own licences and notices. Rather than restate them
					here, where they would fall out of date, the authoritative list
					travels with the code: the licence and NOTICE files in the{" "}
					<a
						className="link"
						href={GITHUB_REPO_URL}
						rel="noreferrer"
						target="_blank"
					>
						repository
					</a>{" "}
					and in each release artifact.
				</p>
			</LegalSection>
			<LegalSection title="Hosted service">
				<p>
					The open-source licence grants rights in the software, not a right to
					use Composery Cloud without paying applicable service fees. Hosted use
					is governed by the Terms of Service.
				</p>
			</LegalSection>
		</LegalPage>
	);
}
