import type { Metadata } from "next";
import Link from "next/link";
import { CopyEmail } from "@/components/copy-email";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { OWNER, WEBSITE_DOMAIN } from "shared";

export const metadata: Metadata = {
	title: "Privacy Policy",
	description: "How Composery Cloud collects, uses, shares, and retains data."
};

export default function PrivacyPage() {
	return (
		<LegalPage title="Privacy Policy">
			<p>
				This policy applies to {WEBSITE_DOMAIN} and the hosted Composery Cloud
				service. {OWNER.legalName}, trading as {OWNER.tradingName} in{" "}
				{OWNER.jurisdiction}, is the data controller for Composery Cloud. A
				person or organisation running the open-source software themselves is
				responsible for their own deployment and is a separate controller.
			</p>
			<LegalSection title="What we collect">
				<ul className="list-disc space-y-2 pl-5">
					<li>
						Account data: your Clerk user identifier, email address,
						authentication and security information, and account settings.
					</li>
					<li>
						Billing data: Polar customer, checkout, and subscription
						identifiers, payment status, and transaction records. Composery does
						not receive your full card number.
					</li>
					<li>
						Service data: box name, server and network identifiers, location and
						type, lifecycle history, snapshots, operational errors, and sampled
						CPU, disk, and network metrics.
					</li>
					<li>
						Security data: IP address and request information may appear in
						provider security logs. Password breach checks send only the first
						five characters of a SHA-1 hash to Have I Been Pwned. Box passwords
						are hashed on the box; Composery Cloud receives and stores only the
						one-way hash.
					</li>
					<li>
						Website measurements: Vercel Web Analytics and Speed Insights
						provide cookieless, anonymized traffic and performance information,
						including page, referrer, browser, device, country, and web-vital
						data. Web Analytics derives a visitor hash that resets daily.
					</li>
				</ul>
			</LegalSection>
			<LegalSection title="Why we use it">
				<p>
					We process account, billing, and service data because it is necessary
					to enter into and perform our contract with you: authenticating you,
					creating and operating boxes, taking payment, providing support, and
					deleting the service. We use operational, security, abuse-prevention,
					and aggregated measurement data for our legitimate interests in
					keeping the service secure, reliable, and understandable. We keep tax,
					accounting, and compliance records where required by law.
				</p>
			</LegalSection>
			<LegalSection title="Providers and international transfers">
				<p>
					We disclose only the data needed to Clerk (identity), Convex
					(application backend), Polar (merchant of record and billing), Hetzner
					(European cloud infrastructure and snapshots), Cloudflare (DNS and
					network services), Vercel (website hosting and cookieless
					measurements), Resend (security and operational alerts, service
					notices about your own boxes, and legal notices about your account),
					and Have I Been Pwned (k-anonymous password checks). These providers
					process data under their own terms and/or our processor agreements.
					Where data leaves the EEA or UK, we rely on an adequacy decision or
					appropriate contractual safeguards supplied by the provider.
				</p>
			</LegalSection>
			<LegalSection title="Retention and deletion">
				<ul className="list-disc space-y-2 pl-5">
					<li>
						While a box is active, we retain the account, service, billing, and
						operational data needed to provide it. Raw metrics are kept for two
						days and hourly metric summaries for 30 days.
					</li>
					<li>
						When a box is deleted, its server, DNS records, snapshots, password
						hash, temporary authorization records, infrastructure identifiers,
						and metrics are removed. We retain a minimized box record, lifecycle
						timestamps, operation and event summaries, and abuse flags for 180
						days for support, abuse prevention, security investigation, and the
						establishment or defence of legal claims. The record is then
						automatically purged.
					</li>
					<li>
						Unpaid checkout records are removed after 30 days. Records needed to
						support billing, tax, refunds, or transaction disputes are retained
						for six years after the related box ends. A record may be retained
						longer only while a specific legal hold, audit, or dispute requires
						it.
					</li>
					<li>
						Staff-only operational alert records, including their delivery state
						and incident context, are removed after 180 days.
					</li>
					<li>
						When we send you a legal notice - a change to these documents or the
						service, or a personal data breach - we keep a record of which
						notice, the address it was sent to, when, and whether it was
						delivered, for six years. That record is how we show a notice we
						were required to give you was actually given. Deleting your account
						replaces the address in it with a non-identifying value and keeps
						the rest.
					</li>
					<li>
						Deleting your account immediately revokes its subscriptions and
						starts the same box deletion process. We remove checkout secrets and
						URLs, replace the email and external identity with non-identifying
						internal values, and pseudonymize retained box and event records.
						The pseudonymous account record is removed after the six-year
						billing retention period once no retained records refer to it.
					</li>
					<li>
						Providers may retain limited backups, fraud, transaction, and
						statutory records for their applicable retention periods.
					</li>
				</ul>
			</LegalSection>
			<LegalSection title="Your rights">
				<p>
					Depending on where you live, you may ask for access, correction,
					deletion, restriction, portability, or an objection to processing. You
					may complain to the Irish Data Protection Commission or your local
					supervisory authority. Email <CopyEmail className="link" /> to
					exercise a right. We may need to check your identity. You can also
					manage or delete your account from the Clerk user menu.
				</p>
			</LegalSection>
			<LegalSection title="Cookies and changes">
				<p>
					See our{" "}
					<Link className="link" href="/cookies">
						Cookie Notice
					</Link>
					. We will update this notice when our processing changes and show the
					new date above. Where a change materially affects an active account we
					will email you about it rather than rely on you re-reading this page.
					If a personal data breach is likely to result in a high risk to your
					rights and freedoms, we will contact you directly and without undue
					delay.
				</p>
			</LegalSection>
		</LegalPage>
	);
}
