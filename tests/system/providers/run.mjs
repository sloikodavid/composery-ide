import {
	CLOUDFLARE_OPENAPI_URL,
	cloudflareResponseContracts
} from "../../../packages/web/convex/boxes/infra/cloudflareContracts.ts";
import {
	HETZNER_OPENAPI_URL,
	hetznerResponseContracts
} from "../../../packages/web/convex/boxes/infra/hetznerContracts.ts";

const providers = [
	{
		name: "Hetzner",
		url: HETZNER_OPENAPI_URL,
		contracts: hetznerResponseContracts
	},
	{
		name: "Cloudflare",
		url: CLOUDFLARE_OPENAPI_URL,
		contracts: cloudflareResponseContracts
	}
];

let currentSpecification;

for (const provider of providers) {
	const specification = await fetchJson(provider.url);
	for (const contract of provider.contracts) {
		const response =
			specification.paths?.[contract.path]?.[contract.method]?.responses?.[
				contract.status
			];
		const schema = response?.content?.["application/json"]?.schema;
		if (!schema) {
			throw new Error(
				`${provider.name} no longer documents ${contract.method.toUpperCase()} ${contract.path} as JSON ${contract.status}.`
			);
		}

		assertProviderFitsConsumer(
			specification,
			schema,
			contract.schema.toJSONSchema(),
			`${provider.name} ${contract.name}`
		);
		console.log(`checked ${provider.name}: ${contract.name}`);
	}
}

async function fetchJson(url) {
	const response = await fetch(url, {
		signal: globalThis.AbortSignal.timeout(30_000),
		headers: { "User-Agent": "composery-provider-check" }
	});
	if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
	return await response.json();
}

function assertProviderFitsConsumer(specification, provider, consumer, label) {
	const previous = currentSpecification;
	currentSpecification = specification;
	try {
		const failures = compatibleVariants(
			expandCurrent(provider),
			expandCurrent(consumer),
			label
		);
		if (failures.length > 0) throw new Error(failures.join("\n"));
	} finally {
		currentSpecification = previous;
	}
}

function compatibleVariants(providerVariants, consumerVariants, path) {
	const failures = [];
	for (const provider of providerVariants) {
		const attempts = consumerVariants.map((consumer) =>
			compatibleVariant(provider, consumer, path)
		);
		if (!attempts.some((attempt) => attempt.length === 0)) {
			failures.push(attempts.sort((a, b) => a.length - b.length)[0][0]);
		}
	}
	return failures;
}

function compatibleVariant(provider, consumer, path) {
	const providerTypes = types(provider);
	const consumerTypes = types(consumer);
	if (
		consumerTypes.size > 0 &&
		[...providerTypes].some((type) => !consumerTypes.has(type))
	) {
		return [
			`${path} can be ${[...providerTypes].join("|")}, but the runtime accepts ${[...consumerTypes].join("|")}.`
		];
	}

	if (provider.enum && consumer.enum) {
		const accepted = new Set(consumer.enum.map(JSON.stringify));
		const rejected = provider.enum.filter(
			(value) => !accepted.has(JSON.stringify(value))
		);
		if (rejected.length > 0) {
			return [`${path} rejects provider values ${JSON.stringify(rejected)}.`];
		}
	}

	if (providerTypes.has("object") && consumerTypes.has("object")) {
		const providerRequired = new Set(provider.required ?? []);
		const consumerRequired = new Set(consumer.required ?? []);
		for (const [name, consumerProperty] of Object.entries(
			consumer.properties ?? {}
		)) {
			if (consumerRequired.has(name) && !providerRequired.has(name)) {
				return [
					`${path}.${name} is required by the runtime but not guaranteed by the provider.`
				];
			}
			const providerProperty = provider.properties?.[name];
			if (!providerProperty) {
				if (!consumerRequired.has(name)) continue;
				return [`${path}.${name} is missing from the provider schema.`];
			}
			const failures = compatibleVariants(
				expandCurrent(providerProperty),
				expandCurrent(consumerProperty),
				`${path}.${name}`
			);
			if (failures.length > 0) return failures;
		}
	}

	if (providerTypes.has("array") && consumerTypes.has("array")) {
		return compatibleVariants(
			expandCurrent(provider.items ?? {}),
			expandCurrent(consumer.items ?? {}),
			`${path}[]`
		);
	}

	return [];
}

function expandCurrent(schema) {
	const resolved = dereference(schema);
	const base = { ...resolved };
	delete base.$ref;
	delete base.allOf;
	delete base.anyOf;
	delete base.oneOf;

	let variants = Array.isArray(base.type)
		? base.type.map((type) => ({ ...base, type }))
		: [base];
	for (const part of resolved.allOf ?? []) {
		variants = cartesianMerge(variants, expandCurrent(part));
	}
	const alternatives = resolved.anyOf ?? resolved.oneOf;
	if (alternatives) {
		variants = cartesianMerge(
			variants,
			alternatives.flatMap((part) => expandCurrent(part))
		);
	}
	return variants;
}

function dereference(schema) {
	if (!schema?.$ref) return schema ?? {};
	if (!schema.$ref.startsWith("#/")) {
		throw new Error(`External schema reference is unsupported: ${schema.$ref}`);
	}
	return schema.$ref
		.slice(2)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
		.reduce((value, part) => value?.[part], currentSpecification);
}

function cartesianMerge(left, right) {
	return left.flatMap((a) => right.map((b) => mergeSchemas(a, b)));
}

function mergeSchemas(left, right) {
	return {
		...left,
		...right,
		properties: { ...(left.properties ?? {}), ...(right.properties ?? {}) },
		required: [
			...new Set([...(left.required ?? []), ...(right.required ?? [])])
		]
	};
}

function types(schema) {
	if (Array.isArray(schema.type)) return new Set(schema.type);
	if (schema.type) return new Set([schema.type]);
	if (schema.properties) return new Set(["object"]);
	if (schema.items) return new Set(["array"]);
	return new Set();
}
