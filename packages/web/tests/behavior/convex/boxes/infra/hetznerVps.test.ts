import ssh2 from "ssh2";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HOST_SSH_PORT } from "@/convex/boxes/infra/artifacts";
import {
	HetznerApiError,
	attachVolumePayload,
	composeryServerListPath,
	createServerPayload,
	createSnapshotImagePayload,
	createVolumePayload,
	isHetznerNotFound,
	isUnassignedPrimaryIp,
	materializeServer,
	parkingVolumeName,
	parkingVolumeListPath,
	parseActionStatus,
	parseCreateImageResponse,
	parseImageResponse,
	parseLocations,
	renderCloudInitUserData,
	placementCandidates,
	primaryIpListPath,
	productVolumeListPath,
	rebuildServerPayload,
	rescuePayload,
	sshKeyIds
} from "@/convex/boxes/infra/hetznerVps";
import {
	type HetznerAction,
	type HetznerImage,
	type HetznerServer
} from "@/convex/boxes/infra/hetznerContracts";
import { authorizedPublicKey } from "@/convex/boxes/infra/hostCredentials";

const { utils } = ssh2;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function stubHostEnv() {
	const keyPair = utils.generateKeyPairSync("ed25519", {
		comment: "composery-test"
	});
	vi.stubEnv("HETZNER_BOX_IMAGE", "ubuntu-24.04");
	vi.stubEnv("HETZNER_FIREWALL_ID", "42");
	vi.stubEnv("HETZNER_SSH_KEYS", "123,456");
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", keyPair.private.replace(/\n/g, "\\n"));
	vi.stubEnv("HOST_SSH_USER", "root");
}

const server = (extra: Partial<HetznerServer> = {}): HetznerServer => ({
	id: 42,
	name: "composery-atlas",
	status: "running",
	created: "2026-08-01T00:00:00Z",
	public_net: {
		ipv4: { ip: "1.2.3.4" },
		ipv6: { ip: "2a01::1/64" }
	},
	server_type: { name: "cx23" },
	location: { name: "nbg1" },
	...extra
});

const action = (extra: Partial<HetznerAction> = {}): HetznerAction => ({
	id: 11,
	status: "running",
	error: null,
	...extra
});

const image = (extra: Partial<HetznerImage> = {}): HetznerImage => ({
	id: 22,
	type: "snapshot",
	status: "creating",
	image_size: null,
	disk_size: 40,
	created: "2026-08-01T00:00:00Z",
	description: "atlas",
	labels: { product: "composery-web" },
	bound_to: null,
	created_from: null,
	...extra
});

describe("server requests", () => {
	test("finds a prior create by immutable labels", () => {
		const query = new URLSearchParams(
			composeryServerListPath("box123").split("?")[1]
		);
		expect(query.get("label_selector")).toBe(
			"product=composery-web,box_ref=box123"
		);
	});

	test("creates a server with both addresses and current SSH access", () => {
		stubHostEnv();
		const payload = createServerPayload(
			{ serverType: "cx23", location: "nbg1" },
			"atlas",
			"box123"
		);

		expect(payload).toMatchObject({
			name: "composery-atlas",
			server_type: "cx23",
			location: "nbg1",
			ssh_keys: [123, 456],
			public_net: { enable_ipv4: true, enable_ipv6: true }
		});
		expect(payload.labels).toMatchObject({ box_ref: "box123" });
		expect(payload.user_data).toContain(authorizedPublicKey());
	});

	// A duplicate is the same server request with a different disk to start from.
	// Everything else has to stay identical - the firewall, the SSH keys, the
	// cloud-init that moves the host's sshd aside - because a duplicate is an
	// ordinary box in every respect except where its files came from.
	test("provisions a duplicate from its source snapshot, changing nothing else", () => {
		stubHostEnv();
		const base = createServerPayload(
			{ serverType: "cx23", location: "nbg1" },
			"atlas",
			"box123"
		);
		const duplicate = createServerPayload(
			{ serverType: "cx23", location: "nbg1" },
			"atlas-copy",
			"box456",
			98765
		);

		expect(duplicate.image).toBe(98765);
		// The base image is what a box gets when no snapshot is named, and the two
		// must not be the same value or this test could not tell them apart.
		expect(base.image).not.toBe(98765);
		// Same request in every other respect.
		expect(duplicate.firewalls).toEqual(base.firewalls);
		expect(duplicate.ssh_keys).toEqual(base.ssh_keys);
		expect(duplicate.user_data).toBe(base.user_data);
		expect(duplicate.public_net).toEqual(base.public_net);
	});

	// The instance's container shares the host's network stack, so its sshd wants
	// port 22 on this machine. If the host's own sshd were still there the
	// container could not bind it, and a box would come up with no SSH at all -
	// on a host the control plane could still reach, so nothing would look wrong.
	// Cloud-init is the only moment this can be arranged: it runs before the
	// runtime is ever started.
	test("moves the host's own sshd aside on the first boot, for the instance", () => {
		stubHostEnv();
		const userData = renderCloudInitUserData();

		expect(userData).toContain(`Port ${HOST_SSH_PORT}`);
		expect(HOST_SSH_PORT).not.toBe(22);
		expect(userData).toContain("/etc/ssh/sshd_config.d/composery-control.conf");
		// Written and then applied - a drop-in nothing reloads is a file that
		// takes effect at the next reboot, which is not when this is needed.
		expect(userData).toContain("systemctl, restart, ssh");
	});

	test("sends current SSH access when it rebuilds any image", () => {
		stubHostEnv();
		expect(rebuildServerPayload(123)).toEqual({
			image: 123,
			user_data: expect.stringContaining(authorizedPublicKey())
		});
	});
});

describe("server placement", () => {
	test("changes only the location, never the plan's server type", () => {
		expect(placementCandidates("cx43")).toEqual([
			{ serverType: "cx43", location: "nbg1" },
			{ serverType: "cx43", location: "fsn1" },
			{ serverType: "cx43", location: "hel1" }
		]);
	});

	test("rejects an empty or unsupported explicit placement set", () => {
		expect(() => placementCandidates("cx23", [])).toThrow(
			"No Hetzner placement candidates"
		);
		expect(() => parseLocations("nbg1,mars1")).toThrow(
			"Unsupported provisioning value"
		);
	});
});

describe("materialising a provider server", () => {
	test("uses the current location field and normalises IPv6 for DNS", () => {
		expect(materializeServer(server())).toEqual({
			serverId: 42,
			serverType: "cx23",
			location: "nbg1",
			ipv4: "1.2.3.4",
			ipv6: "2a01::1"
		});
	});

	test("rejects a provider value the product cannot represent", () => {
		expect(() =>
			materializeServer(server({ server_type: { name: "cx99" } }))
		).toThrow("unsupported type or location");
		expect(() =>
			materializeServer(server({ public_net: { ipv4: null, ipv6: null } }))
		).toThrow("missing public IPv4 or IPv6");
	});
});

describe("snapshot values", () => {
	test("labels a capture with its stable row reference", () => {
		expect(createSnapshotImagePayload("atlas", "desc", "snapshot123")).toEqual({
			type: "snapshot",
			description: "desc",
			labels: {
				product: "composery-web",
				box_slug: "atlas",
				snapshot_ref: "snapshot123"
			}
		});
	});

	test("maps action and image states to workflow values", () => {
		expect(parseActionStatus(action({ status: "success" }))).toEqual({
			status: "success"
		});
		expect(
			parseActionStatus(
				action({
					status: "error",
					error: { code: "failed", message: "disk full" }
				})
			)
		).toEqual({ status: "error", error: "disk full" });
		expect(parseActionStatus(action({ status: "new-state" }))).toEqual({
			status: "running"
		});
		expect(
			parseImageResponse(image({ status: "available", image_size: 12.5 }))
		).toEqual({ status: "available", imageSizeGb: 12.5 });
	});

	test("rejects a create-image response without both resource ids", () => {
		expect(() => parseCreateImageResponse({})).toThrow(
			"Hetzner create_image did not return an action and image id"
		);
	});
});

describe("parking volumes", () => {
	test("creates a labelled preformatted volume in the server location", () => {
		expect(parkingVolumeName("atlas")).toBe("composery-park-atlas");
		expect(createVolumePayload("atlas", "nbg1", 12, "box123")).toMatchObject({
			name: "composery-park-atlas",
			location: "nbg1",
			size: 12,
			format: "ext4",
			automount: false
		});
		expect(
			createVolumePayload("atlas", "nbg1", 12, "box123").labels
		).toMatchObject({ box_ref: "box123" });
		expect(attachVolumePayload(42)).toEqual({ server: 42, automount: false });
		const query = new URLSearchParams(productVolumeListPath(2).split("?")[1]);
		expect(query.get("label_selector")).toBe(
			"product=composery-web,role=parking"
		);
		const repairQuery = new URLSearchParams(
			parkingVolumeListPath("box123").split("?")[1]
		);
		expect(repairQuery.get("label_selector")).toBe(
			"product=composery-web,role=parking,box_ref=box123"
		);
	});
});

describe("recovery keys", () => {
	test("uses numeric ids for both creation and rescue", () => {
		stubHostEnv();
		expect(sshKeyIds("123, 456")).toEqual([123, 456]);
		expect(rescuePayload()).toEqual({
			type: "linux64",
			ssh_keys: [123, 456]
		});
	});

	test.each([undefined, "", "name", "0", "-1", "1.5"])(
		"refuses a key list rescue cannot use: %s",
		(value) => expect(() => sshKeyIds(value)).toThrow(/numeric key ids/)
	);
});

describe("provider identifiers", () => {
	test("reports only Primary IPs with no assignee", () => {
		expect(isUnassignedPrimaryIp({ assignee_id: null })).toBe(true);
		expect(isUnassignedPrimaryIp({})).toBe(true);
		expect(isUnassignedPrimaryIp({ assignee_id: 42 })).toBe(false);
		const query = new URLSearchParams(primaryIpListPath(3).split("?")[1]);
		expect(query.get("page")).toBe("3");
	});

	test("recognises only a Hetzner 404 as missing", () => {
		expect(isHetznerNotFound(new HetznerApiError("gone", 404))).toBe(true);
		expect(isHetznerNotFound(new HetznerApiError("bad", 400))).toBe(false);
		expect(isHetznerNotFound(new Error("404"))).toBe(false);
	});
});
