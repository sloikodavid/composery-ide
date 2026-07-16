// The environment variables a cloud box owner may set on their own box.
//
// Why an allowlist and not a free map: these values are rendered into the box's
// `composery.env`, which the container loads wholesale. An arbitrary key would
// let a saved configuration overwrite the three variables the website manages
// (`COMPOSERY_HASHED_PASSWORD`, `COMPOSERY_CLOUD_BOX_ID`,
// `COMPOSERY_CLOUD_ORIGIN`) and silently take a box off its own password or
// detach it from the control plane. Naming what is settable makes that
// impossible by construction rather than by review.
//
// What is deliberately NOT here, and why - each of these is a decision, not an
// oversight:
//
//   * `COMPOSERY_PASSWORD` / `COMPOSERY_HASHED_PASSWORD` - the box already has
//     one way to set a password, and it checks the value against known-breached
//     lists and reissues the auth grant. A second path through a configuration
//     form would bypass both.
//   * `COMPOSERY_REMOVE_PASSWORD` - it is the self-hosted recovery lever for a
//     password you cannot produce, and a cloud box has a strictly better answer
//     to that exact problem: change the password from the website. Offering it
//     here would not add a capability, it would add a worse version of one the
//     owner already has, whose cost is that the box reopens on *every* boot -
//     including the reboots we cause (a repair, an update, a host migration).
//     The configuration page says this in place of the field rather than
//     staying silent about it.
//   * `PORT`, `COMPOSERY_IDE_PORT`, `COMPOSERY_INIT`,
//     `COMPOSERY_DOCKER_VOLUME_PATH`, `COMPOSERY_CONFIG`,
//     `COMPOSERY_PERSISTENCE` - the compose contract. The rendered compose file
//     and Caddyfile are written against these; changing the volume root detaches
//     the box's files, and changing the port breaks the proxy in front of it.
//     They are infrastructure, not configuration.
//
// `COMPOSERY_DISABLE_AUTH` IS here on purpose. It publishes a root-capable shell
// at a subdomain we operate, which is a genuinely bad idea - but the box is
// privileged and its owner can set it from inside anyway, so refusing would be
// cautious rather than true. It is surfaced with a warning that says what
// actually happens and a typed confirmation, which is the honest treatment.

// What every field has, whatever it holds. Written once: the four variants below
// had their own copies of `key`/`description`, and `boolean` had two
// variants that differed only by whether `dangerous` was set - a second member
// for a property the string fields already carried as optional.
type RuntimeConfigFieldBase = {
	key: string;
	description: string;
	// Set where a wrong value is dangerous rather than merely wrong. The
	// interface requires a typed confirmation for these; nothing here changes how
	// the value is stored or rendered.
	dangerous?: true;
};

export type RuntimeConfigField = RuntimeConfigFieldBase &
	(
		| { kind: "boolean" }
		| { kind: "number"; min: number; max: number }
		| { kind: "enum"; options: readonly { label: string; value: string }[] }
		| { kind: "string"; maxLength: number; secret?: true }
	);

// Longest value we will write into a single env-file line. Generous enough for
// an extensions-gallery JSON blob, bounded so a box's env file cannot be grown
// without limit.
const MAX_VALUE_LENGTH = 2048;

export const RUNTIME_CONFIG_FIELDS: readonly RuntimeConfigField[] = [
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_AUTH",
		description:
			"Serves the editor with no sign-in at all. Anyone who reaches this box's address gets a root-capable terminal, your files, and any credentials on it.",
		dangerous: true
	},
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_FILE_DOWNLOADS",
		description: "Stops the editor offering browser file downloads."
	},
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_FILE_UPLOADS",
		description: "Stops the editor accepting browser file uploads."
	},
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_PROXY",
		description:
			"Turns off the routes that expose ports running inside the box."
	},
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_API",
		description:
			"Every API endpoint returns 404. The API is already unreachable until you mint a key."
	},
	{
		kind: "boolean",
		key: "COMPOSERY_DISABLE_GETTING_STARTED_OVERRIDE",
		description: "Restores the editor's own Getting Started page."
	},
	{
		kind: "enum",
		key: "COMPOSERY_LOG_LEVEL",
		description: "How much the editor writes to its log.",
		options: [
			{ label: "Trace", value: "trace" },
			{ label: "Debug", value: "debug" },
			{ label: "Info", value: "info" },
			{ label: "Warning", value: "warn" },
			{ label: "Error", value: "error" }
		]
	},
	{
		kind: "enum",
		key: "COMPOSERY_SESSION_LIFETIME",
		description:
			"How long a sign-in remains valid. The default is 8 hours. Every browser session asks again after the browser closes, with a 30-day safety cap while it remains open.",
		options: [
			{ label: "Every browser session", value: "browser" },
			{ label: "Every 8 hours", value: "8h" },
			{ label: "Every day", value: "1d" },
			{ label: "Every 7 days", value: "7d" },
			{ label: "Every 30 days", value: "30d" }
		]
	},
	{
		kind: "string",
		key: "COMPOSERY_PROXY_URI",
		description:
			"Template for the links shown in the Ports panel, for example https://{{port}}.example.com. The built-in path proxy works without this.",
		maxLength: 512
	},
	{
		kind: "string",
		key: "COMPOSERY_EXTENSIONS_GALLERY",
		description:
			"Points the editor at a different extension gallery, in the JSON shape the editor's product configuration expects.",
		maxLength: MAX_VALUE_LENGTH
	},
	{
		kind: "string",
		key: "COMPOSERY_GITHUB_TOKEN",
		description:
			"Supplies the editor's GitHub authentication token. The box removes it from the environment of processes it starts.",
		maxLength: 512,
		secret: true
	},
	{
		kind: "string",
		key: "COMPOSERY_COOKIE_SUFFIX",
		description:
			"Distinguishes this box's session cookie when several instances share a parent domain.",
		maxLength: 128
	},
	{
		kind: "number",
		key: "COMPOSERY_RECONNECTION_GRACE_TIME",
		description:
			"Seconds a disconnected session is held open before its terminals are discarded.",
		min: 0,
		max: 86_400
	},
	{
		kind: "number",
		key: "COMPOSERY_IDLE_TIMEOUT_SECONDS",
		description:
			"Asks the editor to exit after this many idle seconds. It is restarted immediately, so this drops sessions rather than freeing the box.",
		min: 0,
		max: 86_400
	},
	{
		kind: "string",
		key: "LANG",
		description: "Overrides the box's locale. Defaults to C.UTF-8.",
		maxLength: 64
	},
	{
		kind: "string",
		key: "HTTPS_PROXY",
		description:
			"Sends the box's outbound HTTPS requests through a proxy you run.",
		maxLength: 512
	},
	{
		kind: "string",
		key: "HTTP_PROXY",
		description:
			"Sends the box's outbound HTTP requests through a proxy you run.",
		maxLength: 512
	},
	{
		kind: "number",
		key: "COMPOSERY_API_TERMINAL_TIMEOUT",
		description:
			"Seconds a one-shot terminal wait may run before it is stopped.",
		min: 1,
		max: 86_400
	},
	{
		kind: "number",
		key: "COMPOSERY_API_TERMINAL_MAX_OUTPUT",
		description:
			"Bytes of raw merged pty output a one-shot terminal wait returns before it is truncated.",
		min: 1,
		max: 67_108_864
	},
	{
		kind: "number",
		key: "COMPOSERY_API_RATE_RPS",
		description: "Sustained API requests per second, per key.",
		min: 1,
		max: 1000
	},
	{
		kind: "number",
		key: "COMPOSERY_API_RATE_BURST",
		description: "API requests a key may burst above the sustained rate.",
		min: 1,
		max: 10_000
	},
	{
		kind: "number",
		key: "COMPOSERY_API_MAX_SESSIONS",
		description:
			"One-shot waits and WebSocket terminal attachments that may run at once, per key.",
		min: 1,
		max: 500
	},
	{
		kind: "number",
		key: "COMPOSERY_API_AUTH_FAIL_PER_MIN",
		description:
			"Failed API authentication attempts per minute, per address, before throttling.",
		min: 1,
		max: 1000
	}
];

export const RUNTIME_CONFIG_KEYS: readonly string[] = RUNTIME_CONFIG_FIELDS.map(
	(field) => field.key
);

const FIELDS_BY_KEY = new Map(
	RUNTIME_CONFIG_FIELDS.map((field) => [field.key, field])
);

export function configurationField(key: string) {
	return FIELDS_BY_KEY.get(key);
}

// Values the configuration page is never sent back, so it cannot echo them into
// a browser cache or an error report. Derived from the field list rather than
// listed again, so marking a field secret is the only thing anyone has to do.
export const SECRET_CONFIG_KEYS: readonly string[] =
	RUNTIME_CONFIG_FIELDS.filter(
		(field) => field.kind === "string" && field.secret
	).map((field) => field.key);

// Reconcile a submitted configuration with what the box already had, for the
// values the page could not read back.
//
// The page cannot round-trip a secret it was never given, so a save has to
// express three different intentions with two states, and the distinction is
// entirely in whether the key was submitted at all:
//
//   * key absent      -> keep whatever the box already has;
//   * key present, "" -> clear it (`normalizeRuntimeConfig` has already dropped
//                        the empty value, so keeping it out is the clear);
//   * key present     -> replace it.
//
// Getting this backwards is silent in the worst way: treating absent as "clear"
// would delete an owner's GitHub token every time they saved the page from a
// browser that never held it, and they would only find out when something that
// used it stopped working.
export function applySecretIntent({
	normalized,
	stored,
	submittedKeys
}: {
	normalized: Readonly<Record<string, string>>;
	stored: Readonly<Record<string, string>> | undefined;
	submittedKeys: readonly string[];
}): Record<string, string> {
	const result = { ...normalized };
	const submitted = new Set(submittedKeys);

	for (const key of SECRET_CONFIG_KEYS) {
		if (!submitted.has(key) && stored?.[key]) {
			result[key] = stored[key];
		}
	}

	return result;
}

export class RuntimeConfigError extends Error {}

// Normalize and check one value, returning exactly the string that will be
// written into the env file. Throwing rather than coercing is deliberate: a
// value silently rewritten into something the owner did not choose is the same
// class of problem as a setting that does not take effect at all.
function normalizeValue(field: RuntimeConfigField, raw: string): string {
	const value = raw.trim();

	if (field.kind === "boolean") {
		// The box enables a `COMPOSERY_DISABLE_*` surface only on an explicit
		// 1/true and treats everything else as off. Storing exactly those two
		// spellings keeps what the interface shows and what the box does aligned,
		// instead of writing a value that reads as "on" here and "off" there.
		if (value === "1" || value === "true") return "1";
		if (value === "0" || value === "false" || value === "") return "0";
		throw new RuntimeConfigError(`${field.key} must be true or false.`);
	}

	if (field.kind === "number") {
		const parsed = Number(value);
		if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
			throw new RuntimeConfigError(`${field.key} must be a whole number.`);
		}
		if (parsed < field.min || parsed > field.max) {
			throw new RuntimeConfigError(
				`${field.key} must be between ${field.min} and ${field.max}.`
			);
		}
		return String(parsed);
	}

	if (field.kind === "enum") {
		const values = field.options.map((option) => option.value);
		if (!values.includes(value)) {
			throw new RuntimeConfigError(
				`${field.key} must be one of ${values.join(", ")}.`
			);
		}
		return value;
	}

	if (value.length > field.maxLength) {
		throw new RuntimeConfigError(
			`${field.key} must be ${field.maxLength} characters or fewer.`
		);
	}
	// The env file is written as single-quoted shell values, so a newline or a
	// single quote would end the value and let the rest of the string become its
	// own line - a way to set a variable that is not on this list. `renderComposeryEnv`
	// refuses these too; rejecting here means the owner is told which field is
	// wrong instead of the whole save failing anonymously.
	if (/[\r\n']/.test(value)) {
		throw new RuntimeConfigError(
			`${field.key} cannot contain quotes or line breaks.`
		);
	}
	return value;
}

// Validate a whole submitted configuration. Unknown keys are rejected rather
// than dropped: silently discarding a variable an owner believes they set is
// exactly the inert-path failure this repo treats as worse than an error.
export function normalizeRuntimeConfig(
	input: Readonly<Record<string, string>>
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const [key, raw] of Object.entries(input)) {
		const field = FIELDS_BY_KEY.get(key);
		if (!field) {
			throw new RuntimeConfigError(`${key} is not a configurable variable.`);
		}
		const value = normalizeValue(field, raw);
		// An empty optional value means "unset", which is not the same as writing
		// an empty string: the box distinguishes an absent variable from a blank
		// one for every string setting here.
		if (field.kind !== "boolean" && value === "") continue;
		result[key] = value;
	}

	return result;
}
