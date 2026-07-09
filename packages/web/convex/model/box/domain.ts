// A domain an owner points at their own box.
//
// The rules live here, in the layer both planes read, because the browser has to
// refuse a malformed name before asking and the control plane has to refuse it
// again before writing one into a Caddyfile.

// Deliberately narrow. This string is rendered into a Caddy site block, so a
// value carrying whitespace, a brace or a scheme is a configuration file with a
// second site in it. A hostname is letters, digits, hyphens and dots, and at
// least one dot - `localhost` is not something anyone points at a cloud box.
const HOSTNAME =
	/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function normalizeCustomDomain(value: string) {
	// Trailing dots are valid DNS and confuse everything downstream; a scheme or a
	// path is somebody pasting a URL, which is a mistake worth correcting rather
	// than rejecting.
	return value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/\.$/, "");
}

export function isValidCustomDomain(value: string) {
	return HOSTNAME.test(normalizeCustomDomain(value));
}

// Whether a name already points at this box.
//
// Checked before the domain is stored, and this is the whole reason the check
// exists: Caddy asks a certificate authority for a certificate the moment a name
// appears in its configuration. A name that does not resolve here fails that
// challenge, and Caddy retries on a schedule until the authority rate-limits the
// box - which then costs the *managed* name its certificate too. Verifying first
// turns that into an error message.
export function resolvesToBox(
	answers: readonly string[],
	ipv4: string | undefined,
	ipv6: string | undefined
) {
	const addresses = new Set(answers.map((answer) => answer.trim()));
	return Boolean(
		(ipv4 && addresses.has(ipv4)) || (ipv6 && addresses.has(ipv6))
	);
}
