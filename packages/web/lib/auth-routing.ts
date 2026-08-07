const localOrigin = "https://composery.local";

function parseAuthorizedOrigin(origin: string) {
	let url: URL;

	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Invalid CLERK_AUTHORIZED_PARTIES origin: ${origin}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`CLERK_AUTHORIZED_PARTIES must use http(s): ${origin}`);
	}

	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error(
			`CLERK_AUTHORIZED_PARTIES entries must be origins only: ${origin}`
		);
	}

	return url.origin;
}

export function parseAuthorizedParties(value: string | undefined) {
	return (value ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean)
		.map(parseAuthorizedOrigin);
}

export function normalizeInternalReturnPath(pathname: string) {
	if (!pathname.startsWith("/") || pathname.startsWith("//")) {
		return "/";
	}

	const url = new URL(pathname, localOrigin);
	if (url.origin !== localOrigin) {
		return "/";
	}

	return `${url.pathname}${url.search}${url.hash}`;
}

export function signInUrlForReturnPath(pathname: string) {
	return `/sign-in?redirect_url=${encodeURIComponent(normalizeInternalReturnPath(pathname))}`;
}
