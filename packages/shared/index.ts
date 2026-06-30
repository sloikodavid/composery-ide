import { ideFeatures, ideTheme, theme } from "./theme.ts";

export { ideFeatures, ideTheme, theme } from "./theme.ts";
export { SHIKI_THEMES } from "./shiki.ts";
export {
	knownHostsEntry,
	sshConfigEntry,
	sshSetupPrompt,
	type SshConnection
} from "./ssh.ts";

// The single source of truth for who/what this project is: brand, identity, and
// the pure (zero-dependency) icon-SVG builders derived from them. Everything here
// is plain data or pure string functions, so every surface imports it DIRECTLY -
// web, the IDE build scripts, and rebrand.mjs - with no generated copies and no
// drift. Node imports it via type-stripping; bundlers transpile it.
//
// Files that cannot import TS (Dockerfile, compose, templates/, .env.example.*,
// CI, Markdown) duplicate these values by hand; CONTAINER_IMAGE and REPO below are
// the canonical copy to sync them to. CSS variables and raster/logo picture assets
// are derived from this file by the generator scripts in ./scripts.

// --- Brand -----------------------------------------------------------------

export const BRAND_NAME = "Composery";
export const LOGO_TEXT = "Composery";

export const ICON_VIEWBOX = "0 0 20 20";
export const ICON_WIDTH = 20;
export const ICON_HEIGHT = 20;

// Logos, icons and app chrome derive from the UI palette so they cannot drift
// into a second greyscale or status palette.
export const BRAND_COLORS = {
	icon: {
		light: theme.light.foreground,
		dark: theme.dark.foreground,
		muted: theme.light.mutedForeground,
		tileStroke: theme.dark.foreground
	},
	surface: {
		ink: theme.light.foreground,
		paper: theme.dark.foreground,
		canvas: theme.light.background,
		border: theme.light.selected,
		lightText: theme.light.foreground,
		darkText: theme.dark.foreground,
		tile: theme.dark.card,
		splash: theme.light.background,
		splashDark: theme.dark.background
	},
	state: {
		success: theme.light.success,
		warning: theme.light.warning,
		destructive: theme.light.destructive,
		info: theme.light.info
	}
} as const;

export const BRAND_THEME = theme;
export const BRAND_IDE_THEME = ideTheme;
export const BRAND_IDE_FEATURES = ideFeatures;

// --- Icon SVG builders (pure, zero-dep) ------------------------------------

// The raw shape is drawn in a 0..20 space then rotated 135deg about (12,12), which
// leaves the ink off-center with uneven padding - it spans ~[0.62..18.23], not the
// full box. This scales and re-centers the ink so the icon fills its 0..20 box flush,
// with no dead space, in every consumer - without changing the design. Ink bounds
// measured with tmp/measure-icon.mjs; update if ICON_PATH or the stroke width changes.
const ICON_PATH =
	"M12 5 L17.6 14.6 C20.6 19.8 19.2 19.8 15.6 19.8 L8.4 19.8 C4.8 19.8 3.4 19.8 6.4 14.6 Z";
// The holes - a circle with a slit running into it - subtract from the icon as one
// even-odd subpath, not as the two shapes they read as: two overlapping subpaths
// cancel where they overlap under even-odd and paint the lens back in. So the
// outline traces their union - up the slit's left wall, over its round cap, down
// the right wall to where it meets the circle at y = 15 - sqrt(3.6^2 - 1.05^2),
// then the long way round the circle. Slit r 1.05 (the old stroke-width 2.1),
// circle r 3.6 at (12,15), both unchanged from the shapes this replaced.
const ICON_HOLES_PATH =
	"M0 0H24V24H0Z M10.95 11.55653 L10.95 3.6 A1.05 1.05 0 0 1 13.05 3.6 L13.05 11.55653 A3.6 3.6 0 1 1 10.95 11.55653 Z";
const ICON_HOLES_ID = "composery-icon-holes";
const ICON_INK_MIN = 0.617;
const ICON_INK_SIZE = 17.617;
const ICON_FIT_SCALE = 20 / ICON_INK_SIZE;
const ICON_FIT_SHIFT = -ICON_INK_MIN * ICON_FIT_SCALE;
const ICON_FIT = `translate(${ICON_FIT_SHIFT} ${ICON_FIT_SHIFT}) scale(${ICON_FIT_SCALE}) rotate(135 12 12)`;

// The holes are clipped, not masked. A <mask> makes the engine rasterize the mask,
// take its luminance and multiply that in - a step engines do not agree on (the
// colour space the luminance is computed in is the known divergence), and the
// intermediate is what carries the hole's antialiasing. WebKit renders those edges
// soft where Blink keeps them crisp, so the icon looked mushy on iOS and nowhere
// else. A clip is pure geometry with no luminance step, so every engine antialiases
// the hole the same way it antialiases the outer edge.
export function iconInner({
	fill = "currentColor",
	holesId = ICON_HOLES_ID
}: {
	fill?: string;
	holesId?: string;
} = {}) {
	return `<g transform="${ICON_FIT}"><clipPath id="${holesId}"><path clip-rule="evenodd" d="${ICON_HOLES_PATH}"/></clipPath><path d="${ICON_PATH}" fill="${fill}" stroke="${fill}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.6" clip-path="url(#${holesId})"/></g>`;
}

export function iconSvg({
	color = BRAND_COLORS.icon.light,
	fill = "currentColor",
	height = 256,
	viewBox = ICON_VIEWBOX,
	width = 256
}: {
	color?: string;
	fill?: string;
	height?: number;
	viewBox?: string;
	width?: number;
} = {}) {
	return `<svg width="${width}" height="${height}" viewBox="${viewBox}" fill="none" color="${color}" xmlns="http://www.w3.org/2000/svg">${iconInner({ fill })}</svg>`;
}

export function iconTileSvg({
	background = BRAND_COLORS.surface.tile,
	fill = BRAND_COLORS.icon.tileStroke,
	radius = 0,
	scale = 0.652,
	size = ICON_WIDTH
}: {
	background?: string;
	fill?: string;
	radius?: number;
	scale?: number;
	size?: number;
} = {}) {
	const iconScale = (256 / ICON_WIDTH) * scale;
	const transform = `translate(128 128) scale(${iconScale}) translate(-10 -10)`;
	const rect = `<rect width="256" height="256"${radius ? ` rx="${radius}"` : ""} fill="${background}"/>`;

	return `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">${rect}<g transform="${transform}">${iconInner({ fill })}</g></svg>`;
}

export function centeredIconSvg({
	color = BRAND_COLORS.icon.light,
	fill = "currentColor",
	scale = 0.652,
	size = ICON_WIDTH
}: {
	color?: string;
	fill?: string;
	scale?: number;
	size?: number;
} = {}) {
	const iconScale = (256 / ICON_WIDTH) * scale;
	const transform = `translate(128 128) scale(${iconScale}) translate(-10 -10)`;
	return `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="none" color="${color}" xmlns="http://www.w3.org/2000/svg"><g transform="${transform}">${iconInner({ fill })}</g></svg>`;
}

// Pre-rendered icon strings the apps embed directly.
export const ICON_SVG = iconInner();
export const ICON_XML = iconSvg();

// --- Identity --------------------------------------------------------------

// Marketing site. The hosted cloud's own domains are env-driven at runtime
// (CLOUD_DOMAIN / WEBSITE_ORIGIN, see packages/web/convex/env.ts); these are the
// build-time defaults for static site copy and links.
export const WEBSITE_DOMAIN = "composery.io";
export const WEBSITE_ORIGIN = "https://www.composery.io";

// The legal person behind Composery Cloud. Shown on the Terms and Privacy pages
// and used as the merchant/support identity. The address is a legal requirement
// for the terms; swap all four fields to re-owner the hosted service.
//
// The email is a role address on the marketing domain, not a person's mailbox,
// and that is deliberate rather than cosmetic. It is printed on the Terms and
// the Privacy Policy as the address for exercising a data-subject right, it is
// the `Reply-To` on every customer email, and it is the security contact the IDE
// ships (see packages/ide/scripts/rebrand.mjs). All three outlive whoever reads
// them today, so none of them may name an individual's inbox. Where it is
// delivered is a DNS concern and is configured, not committed - see
// docs/developing/web/services/cloudflare.md, "Support mail".
export const OWNER = {
	legalName: "David Sloiko",
	tradingName: "Composery",
	jurisdiction: "Ireland",
	address: "20 Templegreen, Newcastle West, Co. Limerick, V42 AH01, Ireland",
	email: `support@${WEBSITE_DOMAIN}`
} as const;

// GitHub coordinates. A fork repoints these once and every derived URL follows.
export const REPO = {
	owner: "sloikodavid",
	name: "composery-ide",
	branch: "main"
} as const;

// Social handles: x.com/<x>, linkedin.com/company/<linkedin>.
export const SOCIAL = {
	x: "sloikodavid",
	linkedin: "composery"
} as const;

// Published runtime image on ghcr. Infra files that can't import TS (Dockerfile,
// compose, templates/, .env.example.*) hardcode this same string - keep in sync.
export const CONTAINER_IMAGE = "ghcr.io/sloikodavid/composery";

// The day Composery Cloud opened, and the one thing the site's age is measured
// from. Edit this date and every "N days old" on the site follows it.
//
// A plain ISO day, read as UTC: the age is printed in days, months and years, so
// the hour it happened in is noise, and a local-time reading would make the
// number depend on where the server sits.
export const LAUNCH_DATE = "2026-08-10";

export const APP_DESCRIPTION =
	"Composery is an always-on cloud IDE: VS Code in the browser or on your phone, self-hosted on your own server or managed in Composery Cloud, and made for long-running AI agents.";

// The browser-facing workbench mount. Code that constructs a Composery URL
// imports this instead of restating the path; non-code configs are pinned to it
// by the route-boundary regression test.
export const IDE_PATH = "/ide/";

// The one-line pitch, in the product's own voice. Longer prose (APP_DESCRIPTION)
// is what search engines and app stores get; this is what a person reads first.
// README.md and docs/index.md cannot import it and copy it by hand - the "brand
// copy" test in tests/invariants/brand-copy.test.ts is what keeps those copies honest.
export const APP_TAGLINE =
	"A secure cloud computer with a powerful UI, usable from any phone or browser.";
