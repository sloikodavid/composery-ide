const vscode = require("vscode");
const qrcode = require("./qrcode-generator.js");

// Opens an editor tab with a QR of the instance URL. The URL is passed in by the
// workbench command (only the browser knows which of the server's addresses
// reached it), and the QR SVG is generated here in node - no client-side script,
// so nothing can fail to load and render blank.
const COMMAND = "composery.showQr";
const TITLE = "QR Code";

// Module side, so the quiet zone below is expressed in modules like the spec is.
const CELL_SIZE = 8;
// The spec's four-module quiet zone belongs inside the SVG, where it scales with
// the code. Layout padding cannot supply it: a short LAN address makes a version
// 2 code whose modules are wide enough that 20px is worth barely two of them.
const QUIET_ZONE = CELL_SIZE * 4;

// URL parsing canonicalises hosts before we see them (127.1 -> 127.0.0.1,
// ::ffff:127.0.0.1 -> [::ffff:7f00:1]), so exact forms are enough here.
const LOOPBACK_IPV6 = /^\[(::1?|::ffff:(7f[\da-f]{2}:[\da-f]{1,4}|0:0))\]$/;
const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;"
			})[c]
	);
}

// A QR is only worth showing when the device that scans it can reach the address.
function isReachableFromAnotherDevice(url) {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return false;
	}
	// Only a fully qualified trailing dot survives canonicalisation.
	const host = url.hostname.replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) {
		return false;
	}
	if (host.startsWith("[")) {
		return !LOOPBACK_IPV6.test(host);
	}
	const ipv4 = IPV4.exec(host);
	if (ipv4) {
		// 127/8 is this machine; 0.0.0.0 is not an address you can dial.
		return ipv4[1] !== "127" && host !== "0.0.0.0";
	}
	return true;
}

// Said once, and nothing else. Composery runs in a container behind a published
// port, so this process only ever sees the container's own addresses - none of
// them is the address a phone would dial, and offering one was offering a dead
// link. There is no better address to name, so the message names none.
const UNREACHABLE =
	"This address only works on this device, so Composery cannot make a QR code for it.";

function render(url) {
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();
	const svg = qr.createSvgTag({
		cellSize: CELL_SIZE,
		margin: QUIET_ZONE,
		scalable: true,
		// Gives the SVG role="img" and a label; the code itself is unreadable to
		// anything that is not a camera.
		title: `QR code for ${url}`
	});
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<!-- No viewport meta: this page is webview content, and Chromium ignores
		     viewport meta in a nested browsing context (measured on Android
		     Chrome 134 - see web-client.diff). -->
		<meta
			http-equiv="Content-Security-Policy"
			content="default-src 'none'; style-src 'unsafe-inline';"
		/>
		<title>${TITLE}</title>
		<style>
			* {
				box-sizing: border-box;
			}
			html,
			body {
				margin: 0;
			}
			body {
				display: flex;
				align-items: center;
				justify-content: center;
				/* dvh, not a percentage: a percentage min-height never resolves
				   against an auto-height <html>, so the card would hug the top of
				   the tab with the whole viewport empty below it. */
				min-height: 100dvh;
				/* A flat 16px, no safe-area term: this is webview content, and a
				   nested browsing context reads every safe-area inset as 0 even
				   when the top frame has a real one, so max(16px, inset) only ever
				   resolved to the 16px. The workbench around us owns the insets. */
				padding: 16px;
				overflow: auto;
				font-family: var(--vscode-font-family);
				color: var(--vscode-foreground);
			}
			.card {
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 16px;
				width: 100%;
				max-width: 360px;
				text-align: center;
			}
			.frame {
				/* Bounded on both axes so no breakpoint has to guess a device size;
				   10rem covers the padding, the gap and a wrapped address. */
				width: min(288px, 100%, calc(100dvh - 10rem));
				aspect-ratio: 1;
				padding: 12px;
				/* Not a brand colour on purpose: a QR quiet zone is scanner input,
				   and white is the contrast every reader is calibrated for. */
				background: #ffffff;
				border-radius: 16px;
			}
			.frame svg {
				display: block;
				width: 100%;
				height: 100%;
			}
			.url {
				margin: 0;
				font-size: 14px;
				word-break: break-all;
				/* One tap takes the whole address, for typing it in by hand. */
				user-select: all;
				-webkit-user-select: all;
			}
		</style>
	</head>
	<body>
		<div class="card">
			<div class="frame">${svg}</div>
			<p class="url">${escapeHtml(url)}</p>
		</div>
	</body>
</html>`;
}

function activate(context) {
	// One panel, and one render per address: setting webview.html reloads the
	// iframe, and the address cannot change while the window is open.
	let panel;
	let rendered;

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND, (value) => {
			let url;
			try {
				url = new URL(typeof value === "string" ? value : "");
			} catch {
				vscode.window.showErrorMessage(
					"Composery could not determine this instance's address."
				);
				return;
			}

			if (!isReachableFromAnotherDevice(url)) {
				vscode.window.showWarningMessage(UNREACHABLE);
				return;
			}

			if (panel) {
				panel.reveal(panel.viewColumn, false);
			} else {
				panel = vscode.window.createWebviewPanel(
					"composeryQr",
					TITLE,
					vscode.ViewColumn.Active,
					{}
				);
				// The panel's own disposal releases this listener; parking it in
				// context.subscriptions would just pile up dead entries.
				panel.onDidDispose(() => {
					panel = undefined;
					rendered = undefined;
				});
			}

			if (rendered !== url.href) {
				try {
					panel.webview.html = render(url.href);
				} catch (error) {
					// The generator throws plain strings (code length overflow).
					panel.dispose();
					vscode.window.showErrorMessage(
						`Composery could not build a QR code for this address: ${String(error)}`
					);
					return;
				}
				rendered = url.href;
			}
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
