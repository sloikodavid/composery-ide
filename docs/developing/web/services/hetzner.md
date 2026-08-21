---
title: Hetzner Cloud
description: Provision and reset boxes on Hetzner Cloud, plus per-box snapshots and their retention.
---

Everything below is in the Hetzner Console (`console.hetzner.cloud`), inside the
project for this environment. Every Convex deployment **must** get its own
Hetzner project: the daily reconciliation cron (`convex/boxes/reconcile.ts`)
assumes it owns everything labeled `product=composery-web` in its project and
auto-deletes snapshot images it finds no `box_snapshots` row for, so a prod and
dev deployment sharing one project would destroy each other's snapshots. The
code manages servers (create, get, list, rebuild, delete, power on/off) and
deletes the Primary IPs attached to deleted boxes
(`convex/boxes/infra/hetznerVps.ts`); the API token, SSH key, and firewall are
created once in the console and referenced by id.

## Create the resources

1. **API token.** Create a project-scoped **Read & Write** API token in the
   project (Project -> Security -> API Tokens). Hetzner tokens are project-scoped
   with no finer-grained permissions. Copy it immediately - it is shown only
   once. -> `HETZNER_CLOUD_TOKEN`.

2. **SSH key.** Generate a dedicated keypair **per deployment**. Each Convex
   deployment must already have its own Hetzner project, and a Hetzner SSH key is a
   project resource, so dev and prod cannot share one registration anyway; using
   distinct keys also keeps a leaked dev key from reaching the prod fleet, since
   the private half is that deployment's trust root. The code constrains only
   two things, both from `convex/boxes/infra/host.ts`: the key must be a type
   `ssh2` can parse (RSA, ECDSA, or Ed25519, in OpenSSH or PEM form), and it
   **must have no passphrase** - the backend never supplies a `passphrase` to
   `ssh2` (`sshTarget` builds only `host`/`username`/`privateKey`), so an
   encrypted key fails to authenticate. Algorithm is your choice; Ed25519 is the recommended default. A
   passphrase-less key is acceptable here because it is a dedicated, rotatable
   key whose value lives only as a Convex deployment secret and whose public half
   is trusted only on boxes you provision.

   ```bash
   mkdir -p ~/.ssh
   ssh-keygen -t ed25519 -C composery-web-dev -f ~/.ssh/composery_web_dev
   ssh-keygen -t ed25519 -C composery-web-prod -f ~/.ssh/composery_web_prod
   ```

   The first line creates `~/.ssh` if it does not exist yet; `ssh-keygen` fails
   with `No such file or directory` when the target directory is missing. When
   prompted for a passphrase, press Enter twice to leave it empty. Use a
   dedicated `-f` path so you do not overwrite your personal `id_ed25519`. This
   writes each private key to `~/.ssh/composery_web_<env>` and each public key to
   `~/.ssh/composery_web_<env>.pub`. The `-C` comment is local bookkeeping only:
   `authorizedPublicKey()` in `convex/boxes/infra/hostCredentials.ts` rebuilds the public
   line from the private key with a fixed `composery-web` comment, so the same
   text lands in `authorized_keys` whatever you name the key. Change a comment
   later with `ssh-keygen -c -C <comment> -f <keyfile>`, which rewrites it in
   place and leaves the key material - and therefore every existing box's trust -
   untouched.

   Run the rest of this step once per deployment, pairing each environment's key
   with that environment's Hetzner project and Convex deployment.
   - **Public key** -> add it as an SSH key in that environment's Hetzner project
     (Project -> Security -> SSH Keys). Put its numeric id in `HETZNER_SSH_KEYS`
     (comma-separated for multiple). Hetzner Rescue accepts ids but not names, so
     the backend refuses a name before it can create a server that it cannot later
     repair. The console does not show the id. Read it from the API:

     ```bash
     curl -s -H "Authorization: Bearer $HETZNER_CLOUD_TOKEN" \
       https://api.hetzner.cloud/v1/ssh_keys
     ```

     Hetzner injects that key into every server it
     creates in this project. The backend also derives this same public key from
     `HOST_SSH_PRIVATE_KEY` and passes it as cloud-init `user_data` on server create,
     reset, and snapshot restore. Hetzner added `user_data` to its rebuild API;
     sending the current value on every rebuild keeps control-plane access from
     depending only on the key selected when the server was first created.

   - **Private key** -> `HOST_SSH_PRIVATE_KEY`, as a single line with each newline
     escaped as `\n` (the code reverses this with `.replace(/\\n/g, "\n")`).
     Produce that exact value and paste it into the Convex dashboard:

     ```bash
     awk '{printf "%s\\n", $0}' ~/.ssh/composery_web_dev
     ```

   Keep `HOST_SSH_USER=root` unless the image's default login user differs. The
   backend uses this key for the whole box lifecycle and recovery channel, not
   as customer-facing SSH access. The private key and `HETZNER_CLOUD_TOKEN` are
   both Convex deployment secrets; that deployment is therefore the fleet trust
   root. A box only receives the public key, and SSH agent forwarding is not
   used.

   `HETZNER_SSH_KEYS` selects the keys that server creation and Hetzner Rescue
   inject. Existing installed systems keep whatever was written into
   `authorized_keys`, while rebuilds install the public key derived from the
   current `HOST_SSH_PRIVATE_KEY`.
   During rotation, install and test the new public key on existing servers
   before replacing the Convex secret, update `HETZNER_SSH_KEYS`, and treat
   revocation of a compromised key as fleet maintenance.
   Hetzner remembers keys selected at server creation and can inject them again
   during a rebuild, so replacing a Convex secret alone does not prove the old
   key has been removed from every existing server.

3. **Firewall.** Create a firewall in the Hetzner project (Project -> Firewalls).
   Add inbound rules allowing TCP **22**, **2222**, **80**, and **443** plus
   **ICMP**, all from any IPv4 and IPv6 (sources `0.0.0.0/0` and `::/0`), and
   nothing else; define **no outbound rules** (in Hetzner firewalls, zero outbound
   rules means all outbound is allowed - adding any outbound rule flips outbound
   to default-deny). Read the
   numeric id from the firewall's URL -> `HETZNER_FIREWALL_ID`. Required:
   provisioning fails fast (`requiredEnv` in `convex/boxes/infra/hetznerVps.ts`)
   rather than create an unfirewalled, internet-exposed box.

   The two SSH ports are different services and both are needed. **22** is the
   instance's own sshd, which a box owner reaches; **2222** is the host's, which
   only this deployment reaches (`HOST_SSH_PORT`). Cloud-init moves the host's
   sshd aside on the first boot so the instance's container - which shares the
   host's network stack - can bind 22. Opening 2222 is therefore a prerequisite,
   not an addition: a firewall without it leaves every box unreachable by the
   control plane the moment cloud-init finishes.

   Port 22 remains public because Convex has no fixed egress IP; cloud-init
   disables SSH passwords. ICMP is needed for path-MTU discovery. Boxes join no
   private network: Hetzner firewalls do not filter private network traffic, so a
   shared network would let customer boxes bypass this isolation.

   **Ports an owner opens.** Because both containers run on the host's network
   stack, a process an owner starts binds the machine's real interface. Whether
   anyone reaches it is decided here and nowhere else - the instance runs no
   firewall of its own, exactly as a plain VPS does not. Securing what they
   expose is the owner's, the same as on any server they rent.

   Leaving this firewall at the four ports above is the conservative default and
   means owner-opened ports stay private. Widening it - to a range, or to all TCP
   and UDP - is what sells boxes as ordinary servers, and it is a deliberate
   change of posture rather than a setting: every abuse complaint for what runs
   behind it arrives here, and the plan's included traffic is this deployment's
   bill rather than the owner's.

   Whichever you choose, keep **2222** open. A box whose control port is closed is
   a box this deployment cannot repair, update, or migrate.

4. **Project id.** Read the numeric id from the project's console URL
   (`console.hetzner.cloud/projects/<id>/...`)
   -> `NEXT_PUBLIC_HETZNER_PROJECT_ID`. This is a frontend-plane var read by
   `ui/lib/dashboards.ts` so the staff console can deep-link a box to its
   Hetzner server; set it in the Next env (local `.env.local` and
   [Vercel](vercel.md)), not on the Convex deployment. It is non-secret, so the
   console action simply hides itself when the id is absent.

## Provisioning and reset

The provisioning code labels servers `product=composery-web` and
`box_slug=<slug>`, creates public IPv4/IPv6, waits for running, then SSHes in and
bootstraps Docker Compose.

The managed Compose project uses Docker's `always` restart policy and its
container-native init. It does not bind the host cgroup tree into the runtime.
The cloud profile pins overlay persistence, so a host that cannot provide the
required mount capability fails instead of silently selecting a different
engine. Docker's `local` log driver rotates both service logs by default, which
keeps normal output from filling the boot disk.

The server type is not configurable: it is the box's [plan](#plans), because a
box provisioned on a type other than the one its plan advertises would be
selling a machine it does not run. `HETZNER_BOX_LOCATIONS` is a comma-separated,
preference-ordered list; provisioning tries each location in that order until one
has capacity for the plan's type. It is optional and restricted to the values
allowed in `convex/schema.ts` - leaving it unset allows every supported
location.

## Plans

A box is sold as a plan, and the plan decides three things: the Hetzner server
type it is provisioned on, the specification shown on the pricing page, and how
many snapshots it includes. All three live together in
`packages/web/convex/model/box/plan.ts`, which is the only place any of them is written
down - the pricing page prints from it, provisioning reads from it, and the
snapshot caps are enforced from it. Nothing is restated here, deliberately:
machines and allowances are product decisions that change without a schema
change, and a copy in this file could only ever go stale.

`convex/schema.ts` owns the plan names as a stored union, and the table is pinned
to it with `satisfies`, so adding a plan fails to compile until both halves
exist - a sellable plan can never have no machine behind it.

**A box's plan is fixed when it is bought.** Nothing moves a box between plans:
there is no resize path, no plan-change operation, and no reconciliation that
would start one. That is what keeps the rest of the lifecycle simple - Reset,
Repair, Restore and Update all rebuild the same server type the box has always
had, and a snapshot is always restorable onto the box it came from because its
disk never changes size.

The corollary is that a subscription can drift from the box it pays for, if plan
changes are enabled in Polar's customer portal and a customer uses one. Nothing
reconciles that, because resizing a live box is not something this system does
and rebilling silently would be worse. The hourly sweep reports it as a staff
warning instead, and [Polar](polar.md) says to keep portal plan changes off.

## Snapshots and the allowance a plan sells

Each plan sells a number of snapshots. A plan may also allow some of them to be
captured on demand by the owner rather than taken automatically each day; where
it does, the owner chooses the split from the box's Snapshots dialog and the two
sides always sum to what the plan sold. Only the manual side is stored on the box
(`manual_snapshot_cap`) and the automatic side is the remainder, so the halves
cannot disagree or exceed the total - the invariant is arithmetic rather than a
validation. Read it through `resolveSnapshotSplit`, never off the column.

Moving the split costs the fleet nothing: capacity admission reserves the plan's
total for every live box regardless of how it is divided, which is why a plan
sells one number instead of two caps. Both ends of the range are reachable,
including all-automatic and all-manual, and the dialog says what each end means
rather than forbidding one.

Shrinking a side never deletes anything. Manual snapshots are the owner's own
checkpoints and are never evicted - new ones are refused until the existing ones
are removed. They have no expiry either: the count cap is the only bound on
them, because a window could only ever delete a checkpoint somebody deliberately
made. Automatic ones roll, evicting the oldest to make room, and are kept for the
retention window in the staff console.

### The rollback snapshot

Every box also gets a snapshot class it did not buy: a rollback snapshot, taken
immediately before Update, Reset and Restore, which are the three operations
whose result the owner cannot otherwise undo. An update is the reason it exists.
Persistence lays a box's own files over the image's baseline and drops the
overlay's whiteouts when that baseline changes, so once a new image has booted, a
file the owner deleted is back and putting the old image on does not remove it
again. Reset and Restore replace the disk outright.

The rules that make it safe are in `convex/model/box/snapshot.ts`, one row per
class:

- it is taken from slots reserved outside the plan's allowance, so an owner who
  has filled every slot they bought still gets one, and none of theirs is ever
  evicted to make room for it;
- the capture runs first and must reach a usable provider image before the
  operation touches anything. If it fails, the operation does not start;
- exactly one is kept per box. The new one is captured, the operation runs, and
  only then is every older one removed - which is what lets a restore read the
  very snapshot it is replacing, and what leaves the previous one in place when
  an operation fails;
- the owner sees it and can restore from it, but cannot delete it. It is
  superseded automatically and costs them nothing.

Restoring any snapshot also puts back the runtime version its disk was taken on,
because a snapshot holds that version's container and every compose render reads
the box's recorded image. The exception is the fleet's minimum version: a
snapshot below the floor is restored onto the floor image instead, and the box's
history records that it was.

### Resource limits and paid checkout

Hetzner's published values such as 5 servers and 30 snapshots are **starting
defaults, not fixed product ceilings and not this deployment's capacity**. The
approved limits for the account are shown on the Hetzner Console **Limits** tab
and can be increased by `Request change` -> `Limit increase`. Never copy either
published default into application code.

The documented project API can list resources but does not expose the account's
approved maximums. Some limits also span projects. In `/console`, an admin must
therefore enter the server and snapshot **allocation for this deployment**. If
dev and prod share one Hetzner account, their allocations must sum to no more
than the account's approved limits. Checkout fails closed until both values are
set. See [Operations](../operations.md#capacity-and-paid-checkout) for the exact
commitment math and incident procedure.

The allocation prevents locally known commitments from exceeding the operator's
plan; it cannot promise that Hetzner will accept a create. Hetzner's response is
authoritative:

- `403 resource_limit_exceeded` means the approved account quantity was reached.
- `412 resource_unavailable` and action failures cover dynamic plan/location
  availability. Hetzner documents that a best-effort availability check can
  still be followed by a failed allocation.
- Composery tries alternative configured type/location candidates for dynamic
  capacity failures. An account-level quota failure skips the pointless
  placement loop and switches the separate global checkout toggle off so later
  customers cannot pay while the provider is known to reject resources. The
  workflow for the already-paid order still retries before declaring
  provisioning terminal.

A customer can still finish Polar checkout just before provider capacity
disappears. Every active checkout reserves a complete package in Composery's
local accounting (one server plus the configured per-box snapshot entitlement), but
it does not create or hold a Hetzner resource before payment. If initial
provisioning still fails, Composery revokes the Polar subscription, refunds the
full remaining refundable amount of the paid order, and runs normal box
deletion. A partially created VPS is included in that cleanup. See
[Polar](polar.md#billing-and-box-lifecycle).

Operationally, check the Limits tab and request increases with lead time; Hetzner
says requests are manually reviewed during business hours. After an increase,
verify it, update the deployment allocation(s), and re-enable checkout if the
circuit breaker paused it. Raising only the Composery number does not raise the
provider limit. Dynamic location/plan unavailability does not trip this switch;
Composery continues through the configured placement candidates instead.

`HETZNER_BOX_IMAGE` must be `docker-ce` - Hetzner's Docker CE app image
(Ubuntu-based, Docker and the Compose plugin preinstalled), referenced by that
name on server create. Bootstrap relies on Docker already being present (it goes
straight to `docker compose ... pull` / `up` in `convex/boxes/infra/host.ts`); it
does not install Docker, so a plain Ubuntu image would fail. Using the app image
also cuts the slowest part of first boot - installing Docker - so the box reaches
a live URL a minute or so sooner. The runtime image itself is still pulled from
`RUNTIME_IMAGE` at provision time, so this changes nothing about what runs in
the box, only how fast the host is ready.

Reset rebuilds the existing Hetzner server from `HETZNER_BOX_IMAGE` instead of
deleting and creating a replacement. That still destroys the VPS disk and returns
the host OS to the base image, but it preserves the server and Primary IP
resources. Reset also re-resolves the deployment's current `RUNTIME_IMAGE` before
bootstrap, so a rebuilt box uses the runtime release configured on the active
[Convex](convex.md) deployment. Box deletion deletes the server and then
explicitly deletes the recorded Primary IPs, with IP-string lookup as a fallback
for older boxes that do not yet have Primary IP IDs stored.

Daily reconciliation automatically deletes untracked Composery snapshot images
after a 2-hour grace period. It deliberately does **not** auto-delete an
untracked server: a database tracking bug could otherwise destroy a live box.
It logs the server and sends a deduplicated Resend staff alert for review. Normal
subscription/account deletion and failed-initial-delivery cleanup use the
tracked delete workflow and do remove the server automatically.

The owner and staff box pages share one Repair dialog. On open it reads
`recoveryStatus`, which probes the public URL and inspects the host over SSH in
parallel, and lays out each layer - website, server, Docker, reverse proxy,
runtime container, the inner editor/web-server/persistence services, and disk -
in plain language, read-only. Its single **Repair** action is the box's one
recovery lever: it gives the box a clean host while keeping its files, so the
owner never has to tell a wedged container apart from a broken host. It first
rewrites the managed files, recreates the containers, and checks the public
endpoint. If that works, Repair stops there. Otherwise it parks the Docker
volumes on a transient Hetzner Volume, rebuilds the server from
`HETZNER_BOX_IMAGE`, copies the files back, and verifies them before deleting
the volume (`workflows/repairBox.ts`). It is gated by a typed-slug confirmation
and is honest about possible downtime. The host rebuild stops the installed
system, boots Hetzner Rescue, mounts the boot disk read-only, and copies every
managed volume before the rebuild. The copy does not depend on the installed
network, SSH service, Docker daemon, or systemd. It reuses the same artifact
renderers as provisioning, so there is no separate recovery seed to drift. A
separate Reset button rebuilds the disk from a clean
image without preserving files; it is the final, explicitly destructive option
and does not delete existing snapshots.

## Box snapshots

Box snapshots are point-in-time copies of a box's whole disk, captured as
Hetzner Cloud _Snapshots_ (`POST /servers/{id}/actions/create_image` with
`type: "snapshot"`) and restored by rebuilding the VPS from that image. The box
is not involved at all - Hetzner snapshots the disk at the hypervisor - so no
credential, encryption key, or pipeline lives on the box, and a box with full
root cannot read, list, overwrite, or delete its own snapshots. All snapshot API
calls are in `convex/boxes/infra/hetznerVps.ts`, alongside the rest of the
Hetzner client; row state and retention live in `convex/boxes/snapshots.ts`.

There are **no new environment variables.** Snapshots reuse the existing
`HETZNER_CLOUD_TOKEN` already set above.

- **How many a box gets is its plan's business**, and how they are split between
  automatic and on-demand is its owner's. See
  [Snapshots and the allowance a plan sells](#snapshots-and-the-allowance-a-plan-sells).
  The capture gate is in `startManualSnapshot` and applies to staff as well as
  owners, because a manual snapshot on a plan without them would spend a provider
  slot capacity admission never reserved for that box - the favour would really be
  a quiet over-subscription of the fleet's quota.
- **Retention is automatic.** The daily `deleteExpiredSnapshots` cron deletes each
  snapshot's Hetzner image **and** its Convex record together once it passes the
  per-class retention in `convex/boxes/snapshotPolicy.ts`. Those windows and the
  manual cooldown are staff-editable in `/console` without a deploy; the counts
  are not, because they are what a plan sells.
- **Provider snapshot quota.** The active approved value is whatever the Hetzner
  Limits tab says, not a published starting default. The deployment allocation
  reserves every live box's full entitlement for its own plan, including unused
  slots, before admitting new checkout. Admission for a _new_ box happens before a
  plan is chosen, so it assumes the largest allowance any plan sells - room for the
  most expensive plan is room for the cheapest, and the reverse is not true. The
  API can still report `resource_limit_exceeded`; that snapshot operation fails,
  checkout is paused as a circuit breaker, and staff reconcile the
  allocation/provider limit before retrying. It does not cancel the running box or
  refund its subscription. Hetzner Backups are a separate per-server product and
  are not implemented here.
- The runtime image needs nothing special for snapshots (no
  `age`/`zstd`/`curl` snapshot pipeline); it only needs what the lifecycle
  already requires.

See [Maintenance](../maintenance.md) for the cron schedule and snapshot polling
constants.

## References

- Hetzner Cloud API: https://docs.hetzner.cloud/reference/cloud
- Hetzner resource limits and increase requests: https://docs.hetzner.com/cloud/general/faq/#are-there-limits-to-the-number-of-resources-i-can-get
- Hetzner server allocation and limits: https://docs.hetzner.com/cloud/servers/faq/#how-many-servers-can-i-create
- Hetzner API tokens: https://docs.hetzner.com/cloud/api/getting-started/generating-api-token
- Hetzner firewalls: https://docs.hetzner.com/cloud/firewalls/faq/
- Hetzner backups and snapshots: https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/
- Hetzner rescaling and the disk-shrink restriction: https://docs.hetzner.com/cloud/servers/faq/
