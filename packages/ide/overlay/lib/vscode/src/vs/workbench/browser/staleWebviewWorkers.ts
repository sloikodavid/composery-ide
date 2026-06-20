/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Service worker registrations stranded under a superseded content stamp.
 *
 * A VS Code webview - markdown preview, notebooks, the settings editor, our own
 * QR panel - is served its files by a service worker registered under the webview
 * endpoint, which sits below the stamped static route. So every update leaves the
 * previous stamp's registration behind, and they accumulate in origin storage that
 * nobody clears. The workbench's own worker is scoped to the site root and carries
 * no stamp, which is what keeps it out of this.
 *
 * Read as a whole path segment, not as a substring. `scope.includes(stamp)` says
 * yes to a stamp that merely contains this one, and `scope.includes('stable-')`
 * says yes to any path with those characters anywhere in it - a workspace folder,
 * a proxied port. Both mistakes end in `unregister()`, which is why anything this
 * cannot read as a stamped scope is left alone rather than guessed at.
 */

// A stamp is a hash - build.sh takes sha256, and upstream took a commit id - so
// a segment carrying anything else was never one of ours to remove.
const STAMPED_SEGMENT = /^stable-([0-9a-f]+)$/;

export function isStaleWebviewWorkerScope(scope: string, stamp: string | undefined): boolean {
	// An unstamped build cannot tell its own registrations from anyone else's.
	if (!stamp) {
		return false;
	}

	let pathname: string;
	try {
		pathname = new URL(scope).pathname;
	} catch {
		return false;
	}

	return pathname
		.split('/')
		.some(segment => {
			const stamped = STAMPED_SEGMENT.exec(segment);
			return stamped ? stamped[1] !== stamp : false;
		});
}
