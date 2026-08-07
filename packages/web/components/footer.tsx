import Link from "next/link";
import { CopyEmail } from "@/components/copy-email";
import { GitHubLogo } from "@/components/icons/github-logo";
import { LinkedInLogo } from "@/components/icons/linkedin-logo";
import { XLogo } from "@/components/icons/x-logo";
import { Logo } from "@/components/logo";
import {
	GITHUB_ADVISORY_URL,
	GITHUB_BUG_URL,
	GITHUB_IDEAS_URL,
	GITHUB_REPO_URL,
	LINKEDIN_URL,
	X_URL
} from "@/convex/model/links";
import { APP_TAGLINE } from "shared";

type FooterLink =
	{ href: string; label: string } | { copyEmail: true; label: string };

const PRODUCT_LINKS: FooterLink[] = [
	{ href: "/boxes", label: "Boxes" },
	{ href: "/pricing", label: "Pricing" },
	{ href: "/docs", label: "Docs" }
];

const RESOURCE_LINKS: FooterLink[] = [
	{ href: "/docs/configuration", label: "Configuration" },
	{ href: "/docs/self-hosting", label: "Self-hosting" },
	{ href: "/docs/api", label: "API" },
	{ href: "/brand", label: "Brand" }
];

const COMMUNITY_LINKS: FooterLink[] = [
	{ href: GITHUB_BUG_URL, label: "Submit an issue" },
	{ href: GITHUB_IDEAS_URL, label: "Request a feature" },
	{ href: GITHUB_ADVISORY_URL, label: "Report a vulnerability" },
	{ copyEmail: true, label: "Support email" }
];

const LEGAL_LINKS: FooterLink[] = [
	{ href: "/privacy", label: "Privacy" },
	{ href: "/terms", label: "Terms" },
	{ href: "/cookies", label: "Cookies" },
	{ href: "/licenses", label: "Licences" }
];

export function Footer() {
	return (
		<footer className="bg-footer text-footer-foreground">
			<div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-12">
				<div className="max-w-sm space-y-3">
					<Logo size="h-12" />
					<p className="text-balance text-sm leading-6 text-muted-foreground">
						{APP_TAGLINE}
					</p>
				</div>

				<div className="grid grid-cols-2 gap-8 sm:grid-cols-4 md:grid-cols-[repeat(4,max-content)] md:justify-self-end md:gap-10">
					<FooterLinkGroup links={PRODUCT_LINKS} title="Product" />
					<FooterLinkGroup links={RESOURCE_LINKS} title="Resources" />
					<FooterLinkGroup links={COMMUNITY_LINKS} title="Community" />
					<FooterLinkGroup links={LEGAL_LINKS} title="Legal" />
				</div>

				<div className="flex flex-row items-center justify-between gap-4 pt-6 text-sm text-muted-foreground md:col-span-2">
					<p>&copy; {new Date().getFullYear()} Composery</p>
					<div className="flex items-center gap-5">
						<a
							className="inline-flex items-center gap-1.5 transition-colors hover:text-footer-foreground"
							href={X_URL}
							rel="noreferrer"
							target="_blank"
						>
							<XLogo className="size-4" />
							<span className="sr-only sm:not-sr-only">X</span>
						</a>
						<a
							className="inline-flex items-center gap-1.5 transition-colors hover:text-footer-foreground"
							href={LINKEDIN_URL}
							rel="noreferrer"
							target="_blank"
						>
							<LinkedInLogo className="size-4" />
							<span className="sr-only sm:not-sr-only">LinkedIn</span>
						</a>
						<a
							className="inline-flex items-center gap-1.5 transition-colors hover:text-footer-foreground"
							href={GITHUB_REPO_URL}
							rel="noreferrer"
							target="_blank"
						>
							<GitHubLogo className="size-4" />
							<span className="sr-only sm:not-sr-only">GitHub</span>
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
}

const FOOTER_LINK_CLASSES =
	"text-sm text-muted-foreground transition-colors hover:text-footer-foreground";

// ponytail: label length proxies rendered width; measure text if fonts make it lie
const byLabelLength = (a: FooterLink, b: FooterLink) =>
	a.label.length - b.label.length;

function FooterLinkGroup({
	links,
	title
}: {
	links: FooterLink[];
	title: string;
}) {
	return (
		<nav className="space-y-3" aria-label={title}>
			<p className="text-sm font-medium text-footer-foreground">{title}</p>
			<ul className="space-y-2">
				{links.toSorted(byLabelLength).map((link) => (
					<li key={link.label}>
						{"copyEmail" in link ? (
							<CopyEmail
								className={FOOTER_LINK_CLASSES}
								label={link.label}
								message="Support email copied"
							/>
						) : link.href.startsWith("/") ? (
							<Link className={FOOTER_LINK_CLASSES} href={link.href}>
								{link.label}
							</Link>
						) : (
							<a
								className={FOOTER_LINK_CLASSES}
								href={link.href}
								rel="noreferrer"
								target="_blank"
							>
								{link.label}
							</a>
						)}
					</li>
				))}
			</ul>
		</nav>
	);
}
