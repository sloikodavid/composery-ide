---
title: Web operations
description: Admin bootstrap, role boundaries, capacity admission, and incident runbooks for the hosted service.
---

This is the operator runbook for the hosted Composery service. Provider setup
belongs under [Services](services/index.md); hardcoded cron and retention
values are in [Maintenance](maintenance.md).

## Admin, staff, and owner terminology

These words are not interchangeable:

| Term                   | Meaning in this project                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `user`                 | Stored application role for an ordinary customer                                                                 |
| `admin`                | Stored application role with every current internal capability                                                   |
| staff                  | Collective name for internal console surfaces and backend modules; it is not a stored role                       |
| box owner              | Customer whose Clerk user ID equals a box's `user_id`; ownership checks grant access only to that customer's box |
| provider account owner | External GitHub/Hetzner/Polar/Resend/etc. organization owner; Composery cannot grant or transfer it              |

V1 intentionally stores only `user` and `admin`. Calling every employee generic
`staff` would make it too easy to grant customer deletion, fleet operations,
billing intervention, settings changes, and alert access as one implied bundle.
It is also unnecessary to invent narrow roles before real people need them.

Instead, `convex/users.ts` explicitly maps roles to capabilities:

- `staff_console` - enter and read the console;
- `box_operations` - operate customer boxes, snapshots, and flags;
- `user_moderation` - suspend or delete customer accounts;
- `settings_management` - checkout, capacity, snapshot, and abuse settings;
- `checkout_management` - release active checkout reservations;
- `box_comp` - mint a free box, which spends real infrastructure;
- `staff_alerts` - receive Resend operational alerts.

Today `admin` has every one of them and `user` has none. Backend functions check
the specific capability; the console link checks `staff_console`. Suspension
removes all capability access. Merely being a non-user role never grants access.

### Add a narrower role later

When the company has a real need such as support staff who may inspect boxes but
not delete accounts or change billing settings:

1. Add the role literal to `vUserRole` in `convex/schema.ts`.
2. Add an explicit capability entry to `ROLE_CAPABILITIES` in
   `convex/users.ts`. Typechecking deliberately fails until this is done.
3. Audit every backend endpoint for the narrow capability it requires; never
   replace this with `role !== "user"`.
4. Gate console controls as well as navigation. Backend denial is the security
   boundary, but controls the person cannot use should not be displayed. The
   client asks `api.users.canAccessStaffConsole` and nothing finer, because with
   one internal role there is nothing finer to ask; a narrower role is what makes
   a per-capability query worth adding.
5. Decide whether the role receives `staff_alerts`, may act on other internal
   accounts, and may be promoted by an admin. Do not infer these powers.
6. Add role/capability, action-denial, UI, migration, and alert-recipient tests.
7. Document the role and assign it only after the production deployment is on
   the new code/schema.

## Bootstrap the first admin

There is deliberately no public "make me admin" route and no email allowlist.
That would turn a configuration mistake into privilege escalation.

1. Deploy Convex and Clerk for the environment.
2. Sign in once with the exact founder/operator Clerk identity. The app creates
   a `users` row with role `user`.
3. In the matching Convex deployment dashboard, open **Data** -> **users**.
4. Match the row by its exact Clerk user ID and email. Change only `role` from
   `user` to `admin`.
5. Refresh the site and open `/console`. Confirm the console link appears and a
   read-only page load succeeds.
6. Repeat separately for development and production; their databases and roles
   are independent.

For later admins, use the same out-of-band process until a reviewed invitation
and role-management flow exists. Before demoting the last admin, promote and
test the replacement. Application-admin changes should be paired with provider
access reviews, because an admin does not automatically own Convex, Hetzner,
Polar, Resend, Vercel, DNS, or GitHub.

## Capacity and paid checkout

Hetzner shows approved account limits in its Console **Limits** tab; the Cloud
API does not expose an authoritative maximum. Some approved limits span
projects. Composery therefore stores an operator-entered **deployment
allocation**, not a discovered quota and not an invented safety percentage.

In `/console`, enter both:

- **Server allocation**: maximum server slots this Convex deployment may commit.
- **Snapshot allocation**: maximum snapshot slots this deployment may commit.

If dev and prod use different projects under one Hetzner account, choose the
allocations so their sum stays within the account's approved limits. Leave
operational headroom by allocating less than the approved value if desired;
make that a conscious account plan, not hidden arithmetic in code. Checkout
fails closed until both allocations are configured.

One live box commits one server slot, the whole snapshot allowance its plan
sells - not how its owner has divided that allowance between automatic and
on-demand, which moves slots between columns without changing the total - and the
slots reserved for the snapshots this deployment takes on its own account
(`RESERVED_SNAPSHOT_SLOTS`). Those are committed for every box whether or not it
has used them, because a box we take a rollback snapshot of costs that image
whether or not it was sold. An
active unpaid checkout commits the allowance for the plan it reserved. Admitting
a _new_ checkout happens before a plan has been chosen, so that gate assumes the
largest allowance any plan sells: room for the most expensive plan is room for
the cheapest, and the reverse is not true. Existing snapshots count directly and
each live box also reserves its unused entitlement, never going below zero.
Deleting/failed snapshot rows with a Hetzner image still count until the image is
gone, and tracked images left by a deleted box count as remnants. This makes the
accounting conservative across asynchronous cleanup.

New checkout is admitted only when one complete package fits in both
allocations. Convex mutation serialization prevents simultaneous reservation
writes from both observing and taking the final slot. An active checkout can be
resumed even when later reservations are blocked, by the customer who holds it
and no one else.

A reservation runs to its Polar checkout's expiry, which Polar sets and its API
gives no way to choose, so the window is Polar's and not a Composery setting.
Whichever end notices first releases the slug and capacity: Polar's
`checkout.expired` webhook, or the sweep reading the same deadline off the
reservation. A reservation that never got a Polar session - the checkout action
died between the two - falls back to the short grace in
[Fixed windows](maintenance.md#fixed-windows), which is the only part of this
Composery chooses.

Existing boxes always have priority. Lowering an allocation below current
commitments does not delete or suspend them; it reports an overcommit and blocks
new checkout. Raising an allocation or removing resources causes calculated
capacity to reopen automatically. The separate checkout toggle remains a manual
pause and never re-enables itself.

Changing the snapshot policy recalculates the full fleet commitment. A change
that would worsen an overcommit is rejected until the allocation is increased;
a change that reduces commitments is allowed. Reducing a cap does not instantly
delete customer-created snapshots. Normal retention/cleanup owns deletion, so the
console may remain overcommitted until cleanup finishes.

### Paid race and provider rejection

A paid webhook can arrive after its original reservation expired. Fulfillment
must reacquire one complete package. If it cannot, Composery does not create an
unallocated box: it revokes the subscription, refunds the remaining refundable
initial order amount, records an idempotent unfulfilled result, and creates a
durable staff alert. Production Resend setup delivers that alert by email; the
console exposes any queue or delivery problem.

Hetzner remains authoritative. A `resource_limit_exceeded` response during
server or snapshot creation manually pauses checkout as a circuit breaker even
when the entered allocation appeared available. This covers stale values,
shared-account consumption, and provider-side changes. Dynamic plan/location
unavailability tries the configured placement candidates and does not by itself
rewrite the allocation.

Calculated server/snapshot exhaustion opens one deduplicated alert episode and
recovery closes it. The independent checkout toggle sends an alert on every
actual state transition, including a provider-triggered circuit breaker. The
complete alert boundary lives in [Resend](services/resend.md#alert-policy).

## Capacity incident runbook

1. Leave existing boxes alone; they own the first claim on committed capacity.
2. Confirm whether checkout is blocked by calculated server capacity,
   calculated snapshot capacity, or the manual checkout toggle.
3. Compare the console commitments with the correct Hetzner account Limits tab
   and project resources. Include the other environment when limits are shared.
4. Inspect active checkout reservations and let valid customers resume. Release
   only clearly abandoned/stuck reservations; normal expiry is the default.
5. Inspect failed/deleting snapshots and reconciliation logs before deleting
   anything manually. Never remove a customer snapshot solely to make a sale.
6. If Hetzner rejected a request, request/verify the provider limit increase or
   reduce the deployment allocation to the real available amount.
7. Update both deployment allocations when the account plan changes. Re-enable
   the manual checkout toggle only after a disposable create/delete or other
   provider check proves the failure is cleared.
8. Reconcile any paid-unfulfilled order in Polar and Convex; confirm revocation,
   refund, deletion cleanup, and webhook/reconciliation completion.

## Publishing a legal change

Changing the Terms, Privacy Policy or Cookie Notice and telling existing
customers you changed them are one act. The repository enforces that: append to
`LEGAL_VERSIONS` in **packages/web/convex/model/legal.ts** and
`tests/invariants/legal/notices.test.ts` fails until an entry in
`LEGAL_NOTICES` announces that version.

The obligation is Article 19 of Directive (EU) 2019/770 - in Ireland the
Consumer Rights Act 2022 - where the change negatively affects a customer's
access to or use of the service by more than a minor degree. It requires notice
**reasonably in advance**, **on a durable medium**, of what is changing, when,
and of the right to terminate free of charge within 30 days of the notice or the
change, whichever is later. Email is a durable medium; this website is not. See
[Resend](services/resend.md), "Legal notices".

Two deploys, in this order:

1. **Announce.** Add the `LEGAL_NOTICES` entry, with `version` set to the
   version you are about to publish, and deploy. The notice text must state what
   changes, the date it takes effect, and the termination right in the
   customer's own words. Do **not** touch `LEGAL_VERSIONS` or the page copy yet:
   the documents on the site must still be the ones customers agreed to while
   the advance-notice period runs. Within 15 minutes the sweep mails every
   account that existed when it started and records a row for each.
2. **Publish, on the effective date.** Edit the page copy and append the version
   to `LEGAL_VERSIONS`. The last-updated date on all three pages and the
   `terms_version` stamped on new orders both follow from it; neither is written
   by hand.

A change that affects nobody's access - a clarification, a new processor already
covered by the same purpose - still gets a version and still gets a notice,
because the version is what customers' acceptance records point at. If it truly
warrants no version, it warrants no date change either: fix the wording and
leave both alone.

Before step 1, check the console shows no legal-notice sender problem. A notice
deployed to a deployment with no `RESEND_ACCOUNTS_FROM` sends to nobody, records
nobody, and raises a critical alert - recoverable, because nothing is marked as
told, but only if somebody reads the alert.

For a personal data breach the shape is the same and the urgency is not: one
`LEGAL_NOTICES` entry with no `version`, deployed as soon as the wording is
right. Article 34 GDPR requires direct communication without undue delay wherever
the breach is likely to be a high risk to the people in it; separately, Article
33 requires notifying the Data Protection Commission within 72 hours, which is
not something this repository does for you.

## Routine checks

- Review `/console` for failed operations, abuse flags, capacity commitments,
  active checkout reservations, and disabled checkout/auto-suspend toggles.
- Act on two alerts that mean a box is stuck rather than merely broken: automatic
  repair reaching its per-box limit (the box is down and nothing further will be
  tried), and an operation still running past its window (the box refuses every
  action while it stays open). **Cancel operation** on the box's console page is
  the lever for the second. See
  [Automatic repair and the operation lock](maintenance.md#automatic-repair).
- Review Convex function and cron failures, Polar webhook deliveries, Hetzner
  actions/resources/limits, Cloudflare records, and Vercel production health.
- Confirm Polar owns customer billing email, that every Resend sender reports
  healthy in the console's delivery panel, and that Resend's own customer mail is
  still only the four box owner notices, the two account notices, and whatever
  legal notices the repository declares. See [Resend](services/resend.md).
- Before changing destructive behavior, read the deletion, retention, refund,
  and reconciliation sections in [Polar](services/polar.md),
  [Hetzner](services/hetzner.md), and [Maintenance](maintenance.md).
