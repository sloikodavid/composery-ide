const vscode = require("vscode");

// Both are injected into the runtime image (Dockerfile ENV) and reach the
// extension host in either init mode (systemd bridges COMPOSERY_* into
// /run/composery.env; supervisor inherits the container env directly).
const CURRENT_VERSION = process.env.COMPOSERY_BUILD_VERSION?.trim() || "unknown";
// e.g. "https://github.com/sloikodavid/composery-ide" -> "sloikodavid/composery".
const REPO = (process.env.COMPOSERY_BUILD_SOURCE || "").match(
	/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
)?.[1];

// Written into the env file by the website on the instances it manages, and
// what decides which oracle is the truthful one. A cloud instance runs whatever
// its fleet's runtime channel resolved to, which deliberately lags the latest
// GitHub release, and its owner cannot pull an image - the website drives the
// update over SSH. So the id alone switches oracles: with it set we never
// consult GitHub, because a release nobody here can install is not an update.
const CLOUD_BOX_ID = process.env.COMPOSERY_CLOUD_BOX_ID?.trim();
const CLOUD_ORIGIN = process.env.COMPOSERY_CLOUD_ORIGIN?.trim();

// The digest this container was started as, written into the env file by the
// website from the same string it put in the compose file. An image cannot
// carry its own digest - hashing the manifest covers the config that would hold
// it - so being told is the only way this Composery can know, and it is what
// lets this check compare exactly what its page compares. Absent on an instance
// provisioned before the website injected it, and on every self-hosted
// instance; both fall back to comparing version labels.
const CURRENT_IMAGE = process.env.COMPOSERY_RUNTIME_IMAGE?.trim();

// Only plain X.Y.Z builds are release-comparable. Preview builds are
// "preview-<sha>" and unreleased dev builds are "unknown" - we never publish a
// GitHub release for those, so an update check would only ever produce noise.
const STABLE = /^\d+\.\d+\.\d+$/;

function isNewer(latest, current) {
	const parts = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
	const [a, b, c] = parts(latest);
	const [x, y, z] = parts(current);
	if (a !== x) return a > x;
	if (b !== y) return b > y;
	return c > z;
}

async function checkGitHub() {
	if (!REPO) return { type: "unavailable" };
	try {
		const response = await fetch(
			`https://api.github.com/repos/${REPO}/releases/latest`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "composery-updates"
				},
				signal: AbortSignal.timeout(10_000)
			}
		);
		if (!response.ok) return { type: "unavailable" };

		const release = await response.json();
		const tag = String(release.tag_name || "").replace(/^v/, "");
		if (!STABLE.test(tag) || release.prerelease || !release.html_url) {
			return { type: "unavailable" };
		}
		return isNewer(tag, CURRENT_VERSION)
			? { type: "available", version: tag, url: release.html_url }
			: { type: "current" };
	} catch {
		return { type: "unavailable" };
	}
}

async function checkCloud() {
	let endpoint;
	let pageUrl;
	try {
		// Served by packages/web/app/api/cloud/runtime; the instance page is the
		// path packages/web/lib/box-route.ts builds. An origin the website never
		// set (or half a pair) throws here and reports a failed check.
		endpoint = new URL("/api/cloud/runtime", CLOUD_ORIGIN).toString();
		pageUrl = new URL(`/boxes/${CLOUD_BOX_ID}`, CLOUD_ORIGIN).toString();
	} catch {
		return { type: "unavailable" };
	}

	try {
		const response = await fetch(endpoint, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) return { type: "unavailable" };

		const body = await response.json();
		const fleet = String(body?.version ?? "");
		const fleetImage =
			typeof body?.image === "string" ? body.image.trim() : "";

		// Digests first, because that is what the instance's page compares.
		// Comparing version labels instead would let a rebuild published under an
		// unchanged label read as "current" here while the page correctly offered
		// an update - two Composery surfaces disagreeing about the same instance.
		//
		// A difference means "not what the fleet is on", not "older": the fleet can
		// be deliberately rolled back, and this Composery should follow it either
		// way. That is the same rule `runtimeStanding` applies on the website.
		if (CURRENT_IMAGE && fleetImage) {
			if (CURRENT_IMAGE === fleetImage) return { type: "current" };
			return {
				type: "available",
				// Only name a version we can actually vouch for; the digest already
				// told us something changed.
				version: STABLE.test(fleet) ? fleet : null,
				url: pageUrl
			};
		}

		// No cached fleet release, or a shape we cannot compare, is not evidence
		// that this Composery is current - it is a check that did not happen.
		if (!STABLE.test(fleet)) return { type: "unavailable" };
		return isNewer(fleet, CURRENT_VERSION)
			? { type: "available", version: fleet, url: pageUrl }
			: { type: "current" };
	} catch {
		return { type: "unavailable" };
	}
}

async function checkForUpdates() {
	if (!STABLE.test(CURRENT_VERSION)) return { type: "development" };
	return CLOUD_BOX_ID ? await checkCloud() : await checkGitHub();
}

let checking = false;

async function runCheck(manual) {
	if (checking) return;
	checking = true;
	try {
		const result = await checkForUpdates();

		if (result.type === "available") {
			// A cloud owner has no image to pull and no use for a release page, so
			// the offer names the one thing they can actually do.
			const label = CLOUD_BOX_ID ? "View Instance" : "View Release";
			// The digest comparison can tell that the image changed without the
			// registry naming the new version, so the cloud message has to work
			// without one rather than printing "Composery null is available".
			const cloudMessage = result.version
				? `Composery ${result.version} is available for this instance. You have ${CURRENT_VERSION}. Update it from your instance's page on Composery Cloud.`
				: `A newer image is available for this instance. You have Composery ${CURRENT_VERSION}. Update it from your instance's page on Composery Cloud.`;
			const action = await vscode.window.showInformationMessage(
				CLOUD_BOX_ID
					? cloudMessage
					: `Composery ${result.version} is available. You have ${CURRENT_VERSION}.`,
				label
			);
			if (action === label) {
				await vscode.env.openExternal(vscode.Uri.parse(result.url));
			}
		} else if (manual) {
			if (result.type === "current") {
				await vscode.window.showInformationMessage(
					// On a cloud instance this compares the same digest its page does,
					// so "current" means this Composery runs exactly the fleet's image -
					// not merely that the two carry the same version label. A newer
					// Composery release the fleet has not moved to yet is still not this
					// instance being behind, which is why the wording names the fleet
					// rather than claiming this is the newest Composery in existence.
					CLOUD_BOX_ID
						? `Composery ${CURRENT_VERSION} is the current Composery Cloud release.`
						: `Composery ${CURRENT_VERSION} is up to date.`
				);
			} else if (result.type === "development") {
				const version = CURRENT_VERSION === "unknown"
					? "This development build has no release version."
					: `You have development build ${CURRENT_VERSION}.`;
				await vscode.window.showInformationMessage(
					`${version} Updates are checked automatically in stable releases.`
				);
			} else {
				await vscode.window.showWarningMessage(
					`Couldn't check for updates. You have Composery ${CURRENT_VERSION}. Try again later.`
				);
			}
		}
	} finally {
		checking = false;
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("composery.checkForUpdates", () => {
			void runCheck(true);
		})
	);

	void runCheck(false);
}

function deactivate() {}

module.exports = { activate, deactivate };
