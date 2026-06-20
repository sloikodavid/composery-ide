/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Links whose callback lands on the wrong machine.
 *
 * A sign-in link carries the address it will send the browser back to, and in a
 * remote workspace that address is written for the machine the editor is running
 * on, not the one holding the browser. The flow completes against a loopback port
 * on the wrong host: nothing arrives, and nothing says why.
 *
 * So a link is inspected before it is opened, and the one that names a loopback
 * callback is worth warning about. A link that is itself loopback is not - the
 * user asked for that address directly, and upstream's trusted-domain handling
 * already has an opinion about it.
 */

// Every spelling of the redirect parameter this has been seen to travel under,
// compared with punctuation and case removed - so redirect_uri, redirectUri and
// Redirect-URI are one name.
const CALLBACK_PARAM_NAMES = new Set([
	'callback',
	'callbackto',
	'callbackuri',
	'callbackurl',
	'continue',
	'continueto',
	'continueuri',
	'continueurl',
	'destination',
	'destinationuri',
	'destinationurl',
	'next',
	'nexturi',
	'nexturl',
	'postlogoutredirecturi',
	'postlogoutredirecturl',
	'redirect',
	'redirectto',
	'redirecturi',
	'redirecturl',
	'return',
	'returnto',
	'returnuri',
	'returnurl',
	'targetlinkuri',
]);

// An identity provider hands off to a second one, which carries the first one's
// return address - so the loopback target can sit a level or two down. Bounded
// because the nesting is attacker-shaped: a link can carry itself.
const MAX_NESTED_CALLBACKS = 2;

function normalizeParamName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseHttpUrl(value: string | undefined): URL | undefined {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}

	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isLoopbackHost(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase();
	return normalized === 'localhost'
		|| normalized === 'localhost.'
		|| normalized.endsWith('.localhost')
		|| normalized.endsWith('.localhost.')
		|| /^127(?:\.\d{1,3}){3}$/.test(normalized)
		|| normalized === '0.0.0.0'
		|| normalized === '::1'
		|| normalized === '[::1]'
		|| normalized === '::'
		|| normalized === '[::]'
		|| isIpv4MappedLoopbackHost(normalized);
}

// ::ffff:7f00:0/104 - 127.0.0.0/8 written as an IPv6 address, which resolves to
// the same interface and reads as nothing of the sort.
function isIpv4MappedLoopbackHost(normalized: string): boolean {
	const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(normalized);
	if (!match) {
		return false;
	}

	const highBits = parseInt(match[1]!, 16);
	return highBits >= 0x7f00 && highBits <= 0x7fff;
}

// Query strings live in two places. A single-page app puts its parameters after
// the hash, either as its own query (#/path?redirect_uri=...) or as the whole
// fragment (#redirect_uri=...), and a callback hidden there is no less a callback.
function queryLikeParams(url: URL): URLSearchParams[] {
	const params = [url.searchParams];
	const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
	if (!hash) {
		return params;
	}

	const hashQueryIndex = hash.indexOf('?');
	if (hashQueryIndex >= 0 && hashQueryIndex < hash.length - 1) {
		params.push(new URLSearchParams(hash.slice(hashQueryIndex + 1)));
		return params;
	}

	if (hash.includes('=')) {
		params.push(new URLSearchParams(hash));
	}

	return params;
}

function search(url: URL, depth: number): URL | undefined {
	if (depth > MAX_NESTED_CALLBACKS) {
		return undefined;
	}

	for (const params of queryLikeParams(url)) {
		for (const [key, value] of params) {
			if (!CALLBACK_PARAM_NAMES.has(normalizeParamName(key))) {
				continue;
			}

			const parsedValue = parseHttpUrl(value);
			if (!parsedValue) {
				continue;
			}

			if (isLoopbackHost(parsedValue.hostname)) {
				return parsedValue;
			}

			const nestedTarget = search(parsedValue, depth + 1);
			if (nestedTarget) {
				return nestedTarget;
			}
		}
	}

	return undefined;
}

/**
 * Where `link` would send the browser back to, when that is a loopback address
 * this workspace cannot answer on - and undefined when there is nothing to warn
 * about, which is every other link.
 */
export function findLoopbackCallbackTarget(link: string): URL | undefined {
	const url = parseHttpUrl(link);
	if (!url || isLoopbackHost(url.hostname)) {
		return undefined;
	}

	return search(url, 0);
}
