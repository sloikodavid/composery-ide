---
title: Resend
description: Configure and verify alert, box owner notice, and legal notice delivery.
---

Resend sends three kinds of mail, each named for what it is about and each with
its own sender:

| Class          | Variable               | About                          | Reaches              |
| -------------- | ---------------------- | ------------------------------ | -------------------- |
| Alert          | `RESEND_ALERTS_FROM`   | An incident on this deployment | Internal admins      |
| Box notice     | `RESEND_NOTICES_FROM`  | One customer's box             | That box's owner     |
| Account notice | `RESEND_ACCOUNTS_FROM` | The account itself             | That account holder  |
| Legal notice   | `RESEND_ACCOUNTS_FROM` | The agreement, or their data   | Every account holder |

Polar owns all customer-facing order, subscription, renewal, cancellation,
refund, and payment email, and Clerk owns all identity email; Composery restates
neither. There is no onboarding sequence and no marketing mail. Inbound mail is
not Resend's - see [Cloudflare](cloudflare.md), "Support mail".

Production is not launch-ready until this page is complete. The application can
run without Resend, but important events then remain queued as **disabled** and
the staff console shows the delivery configuration as unhealthy.

## Recipients and volume

Every non-suspended application user whose role has the **staff_alerts**
capability receives each alert, up to 50 recipients. V1 gives that capability
only to **admin**; an ordinary customer is never selected. Adding another admin
therefore adds another alert recipient intentionally.

The traffic is incident-driven, not user-volume-driven. Normal sign-up,
checkout, renewal, cancellation, snapshot retention, and successful box
operations send no Resend email.

## Sending identity, and when it changes

Three senders, one verified domain. The split between them is a split between
**addresses**, not between domains, and the difference is the whole of this
section: an address costs nothing and is what a recipient reads and filters on,
while a verified domain costs a slot in the Resend account and a reputation that
only volume earns.

At the volumes this service starts at, three domains would be three that no
receiver has heard of. Concentrating everything behind one is better for
deliverability than isolating streams that have not yet sent enough mail to be
worth isolating. So verify **the marketing domain itself** and put all three
addresses on it, alongside the support address
([Cloudflare](cloudflare.md), "Support mail") that shares it.

**One word per sender, used at every layer.** `alerts`, `notices` and
`accounts` each name the environment variable, the display name, the local part
in front of the `@`, the helper in `convex/email.ts` and the key the console's
delivery panel reports. There is no mapping between layers because there is
nothing to map - pick the word and the rest follows.

The addresses themselves are in `.env.example.convex.prod`, with the rest of the
plane's values. This page does not repeat them: a value written in two places is
a value that will disagree with itself, and the example file is the one the
setup is copied from.

They are separate from the first message because an address is the unit a
recipient acts on. A filter, a contact entry, a block: all of them key on the
`From` address and none of them read the subject line. So one shared customer
address would mean somebody irritated by box mail - deleted, suspended, could
not be created, the notices that carry bad news - silencing the account notices
they are legally owed, with no way to keep one and drop the other.

Doing it now rather than when that first happens is the whole point. Addresses
cost nothing, so there is no saving to bank by folding them; what folding would
buy is a migration later, performed under complaint pressure, changing a `From`
that customers' filters and providers have already learned. Split domains have a
threshold below because they cost something real. Split addresses do not, so
they have no threshold and no later.

Never use the runtime-box domain (`CLOUD_DOMAIN`, the hostname customer boxes
are served on) for any of them. Verifying the marketing domain for mail has no
effect on SEO or search ranking, which do not read mail-authentication DNS.

### The one risk this accepts

A customer marking a service notice as spam degrades the domain the staff alerts
also ride on, so a bad enough week for customer-mail reputation could take out
the channel that reports the fleet is broken - at the moment it is most needed.
That is a real cost and it is accepted deliberately, because two cheap things
cover it until volume makes the separation worth its price:

- alerts are addressed to people who can allowlist them, and a rule in the
  receiving mailbox that never files `alerts@` as spam removes almost all of it;
- email is not the alert channel's only surface. A `staff_alerts` row is written
  before any send is attempted, and the console's delivery panel reports the
  failures, so a degraded channel is visible in the product rather than only in
  its absence.

### When to split the domain

**At roughly 100 account holders, or the first time this service sends anything
that is marketing rather than service mail - whichever comes first.**

The first number is not arbitrary. Resend's free tier is capped per day as well
as per month, and a legal notice is one individually addressed message per
account holder in a single burst, so the account count at which one notice
consumes a whole day's allowance is the account count at which the free tier
stops fitting the product. Check the current caps against the fleet size rather
than trusting a number written here; what matters is that the daily cap, not the
monthly one, is the binding constraint, because the notice arrives as a burst.

The second is a rule with no threshold: marketing mail never shares a reputation
with mail a customer is obliged to receive, from the first message.

Paid tiers lift the domain allowance at the same moment they lift the volume
cap, which is why one threshold decides both. The shape to move to:

| Domain                | Carries                                       |
| --------------------- | --------------------------------------------- |
| `composery.io`        | `support@` - human correspondence only        |
| `mail.composery.io`   | `RESEND_NOTICES_FROM`, `RESEND_ACCOUNTS_FROM` |
| `alerts.composery.io` | `RESEND_ALERTS_FROM`                          |
| a further subdomain   | marketing, if it ever exists                  |

Only the part after the `@` moves. The three addresses were always distinct and
stay distinct; what they stop sharing is a reputation. The apex reverts to what
it should have been all along - the human address and nothing automated - and
the reason it was not that from the start is the domain allowance, not a
judgement that automated mail belongs there.

Moving is verifying the new domains and changing three environment values. No
code changes - the senders are variables and have never cared what domain they
name - no data migration, and mail already delivered is unaffected. Warm the new
subdomains by leaving each stream on its new address for a while before the
first large send.

## What mailbox providers require of us

Gmail and Microsoft both publish rules a sender has to meet, and both draw the
line at **5,000 messages a day** to their own users. Below that line only the
everyone column binds; above it, the rest starts being enforced. Both columns
are met by the same configuration, because Resend and the DNS records do that
work whatever the volume.

| Requirement                                       | Applies to  | How it is met                                                  |
| ------------------------------------------------- | ----------- | -------------------------------------------------------------- |
| SPF **or** DKIM                                   | Everyone    | Resend publishes both                                          |
| Valid forward and reverse DNS on the sending host | Everyone    | Resend's infrastructure, not ours                              |
| TLS on the connection                             | Everyone    | Resend's infrastructure, not ours                              |
| Spam complaints under 0.3%                        | Everyone    | Watched - `email.complained` raises a **critical** alert       |
| Message format per RFC 5322                       | Everyone    | The Resend component builds the message                        |
| SPF **and** DKIM, plus DMARC                      | 5,000 a day | [Cloudflare](cloudflare.md), "Proving mail is really from you" |
| `From:` aligned with the SPF or DKIM domain       | 5,000 a day | Same domain throughout, so aligned by construction             |
| One-click unsubscribe                             | 5,000 a day | **Does not apply** - see below                                 |

The unsubscribe rule is the only one worth arguing about, and the argument is
that it covers "marketing and subscribed messages". Nothing here is either: a
box notice reports something that happened to a customer's own server, and an
account notice is a legal obligation. There is nothing to unsubscribe from, and
offering it would invite somebody to opt out of a notice they are owed. Should
Composery ever send a newsletter, that is marketing, it needs one-click
unsubscribe from its first message, and it belongs on its own domain
([Sending identity](#sending-identity-and-when-it-changes)).

The two thresholds are worth remembering rather than the details: cross 5,000 a
day to Gmail or to Microsoft consumer addresses and the stricter column starts
being enforced, with Microsoft rejecting outright rather than filtering.

## Delivery model

**convex/staff/alerts.ts** inserts a deduplicated **staff_alerts** row before
trying email. The row records queue state, recipient count, Resend email ID,
latest delivery event, and any error. Disabled, recipient-less, or failed queue
attempts retry every 15 minutes. Rows remain for 180 days. **convex/email.ts**
owns the Resend client and answers whether a given class of mail can be sent at
all, so no two senders can disagree about it.

Each sender is a separate variable, and the console's delivery panel reports one
line per class rather than a single "sending is configured". That is not
cosmetic. While there was one shared sender, a deployment that could not mail a
box owner was visibly a deployment whose alert channel was down. Splitting the
senders destroyed that inference, and an unset **RESEND_ACCOUNTS_FROM** is the
worst thing it could leave behind: legal notices that go nowhere, silently, on
the one channel whose purpose is proving a customer was told. Nothing else on
this deployment is waiting for that mail, so nothing else would notice.

The **/resend/events** Convex HTTP route verifies Resend's signed webhook and
records **email.\*** delivery events. The staff console stays quiet when sending,
recipients, and tracking are healthy; it names the alerts that need attention
when one is unqueued, bounced, complained about, failed, or delayed. An alert
Resend has not reported on counts as unaccounted for only where
**RESEND_WEBHOOK_SECRET** is set: without it no event can ever arrive, and the
console reports that missing configuration itself rather than restating it once
per alert.

## Alert policy

An alert opens on a fact a staff member has to act on, and only on one: a
protection changing state, a workflow ending failed, a paid checkout that could
not be delivered, a resource nobody owns, a sweep that gave up. Every one is
raised through `raiseAlert` (**convex/staff/alerts.ts**), and the call sites are
the list - this page deliberately does not restate them, because an enumeration
of eighteen alerts in a document is one that silently falls behind the code, and
this one had.

What each alert is _about_ is its deduplication key, so re-raising it is a no-op
until the thing it names changes. That is the whole mechanism, and it is what
lets a sweep run every fifteen minutes without mailing anybody twice: a key
naming one box, operation, order, flag or server opens once for that subject; a
key naming a time window opens once per window, for the failures that are
properties of the deployment rather than of any one row.

Expected events do not email: unpaid checkout expiry/cancellation, customer
cancellation/refund, successful operations, routine snapshot cleanup, and an
individual transient metrics-poll failure. Those remain visible in their normal
provider, Convex log, or console surface. This boundary keeps an incident inbox
actionable.

## Box owner notices

**convex/notice/owner.ts** sends the owner of a box exactly four notices, from
**RESEND_NOTICES_FROM**. Each is sent from the lifecycle mutation that makes it
true, and each is something the owner cannot learn any other way at the moment
it happens, because nobody opens the website to check whether a box they were
not using is still there.

| Notice        | When it is sent                               | What it says                                                         |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Deleted       | A delete operation succeeds                   | The box and its snapshots are gone and cannot be recovered, plus why |
| Suspended     | A suspend operation settles at **suspended**  | The server is off, the files are intact, and how to have it reviewed |
| Unsuspended   | An unsuspend operation settles at **running** | The box is back                                                      |
| Create failed | A **create** operation ends failed            | Nothing is running, staff already know, and it need not be reported  |

Two rules decide the wording, and both exist so a message cannot leak what was
written for someone else:

- **The deletion reason is read from the operation's trigger**, which is the only
  record of who ordered the teardown that reaches the mutation finishing it. A
  subscription ending, an account deletion, and a staff comp revoke each get
  their own sentence; `system:delete_retry` gets none, because an operation that
  re-drives someone else's deletion genuinely does not know the reason.
- **A suspension's reason is forwarded, whoever suspended the box.** It used to
  forward an automatic reason and withhold a staff one, on the argument that a
  staff note is written for other staff. Three surfaces disagreed with that: the
  console's suspend dialog offers customer-worded presets under a field telling
  staff the reason is shown to the account owner, and both the owner's own box
  page and the account block already display it. Withholding it here protected
  nothing and only made the email say less than the page it links to. If that is
  ever revisited, all four move together.

An owner notice never carries an operation's error text: those are written for
staff and carry host names, provider messages, and addresses. That boundary is
the real one, and it is about the text's audience rather than about who typed
it.

Everything else about a box - started, stopped, snapshotted, repaired, an update
waiting, a failed reset - is on the box's own page and is not mailed. A failed
**delete** is deliberately silent too: the owner never asked for it, the hourly
sweep is already retrying, and there is nothing for them to do but worry.

Notices are not queued, retried, or tracked per message. If the send cannot be
queued, one **warning** alert per six-hour window tells staff, and the notice is
dropped rather than re-sent later against a box whose state has since moved on.

A notice that is accepted and then fails to arrive has no row to record it
against, so **/resend/events** raises a staff alert instead, from the event
payload alone - Resend echoes the recipient and the subject, and an owner
notice's subject names its box. Two severities, because they are two different
problems:

| Event                           | Severity     | Why                                                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `email.bounced`, `email.failed` | **warning**  | One owner was not told what happened to their box. Nothing retries it; reaching them is a manual step, if it is worth one |
| `email.complained`              | **critical** | Not the recipient's problem but the sender's: every stream shares one verified domain, so one reputation                  |

The complaint case is why this is tracked at all, and it matters more while
everything shares a domain. An owner marking a service notice as spam degrades
the reputation the legal notices ride on - and the staff alerts with them.
Unreported, that surfaces later as mail quietly failing to deliver, the symptom
without the cause. Separate addresses are what keep one stream's
complaints from muting another in a recipient's own mail rules, but they cannot
protect a shared sending reputation; only separate domains do that, and
[When to split the domain](#when-to-split-the-domain) is when that becomes worth
its price.

## Account notices

**convex/notice/account.ts** tells one account holder that their account was
suspended or restored, from **RESEND_ACCOUNTS_FROM**. It is the sibling of the box
notices one level up: same discipline, same never-throw contract, and the sender
follows the subject.

It closes a gap rather than adding a channel. Suspending an account suspends its
boxes, and each of those already mails its owner - so an account with a running
box was told by accident, and an account with none was told nothing at all.
Those are most of the accounts worth suspending: somebody between purchases,
somebody whose boxes are stopped, somebody who has signed up and not bought yet.
For them the account is the only thing there is to suspend, and the website's
block card is the only place it is said - a place they only reach by going
looking, which is exactly what a suspended person has no reason to do.

Sent only when the value actually changes. The mutation behind it is idempotent
on purpose and the console will call it on an account already in that state;
every other effect of a repeat call is a no-op, and an email is the one a person
would read as a second suspension.

Notices are not queued, retried or recorded. As with the box notices, a send that
cannot be queued raises one **warning** alert per six-hour window - the window is
shared with them (`customerEmailAlertKey`), because a queue failure is a property
of the deployment and not of either stream.

## Legal notices

**convex/notice/legal.ts** mails every account holder individually, from
**RESEND_ACCOUNTS_FROM**, and records who was told. It is the only channel that
reaches the whole customer base, and it exists for two obligations that must be
delivered to a person rather than published at them:

- **A modification of the service that affects an existing customer.** Composery
  Cloud is a digital service under Directive (EU) 2019/770, transposed in Ireland
  by the Consumer Rights Act 2022. Article 19 permits modification over the
  contract's life, but where the change negatively affects the customer's access
  or use by more than a minor degree they must be informed reasonably in advance
  **on a durable medium** of what is changing, when, and of their right to
  terminate free of charge within 30 days. A page on this website is not a
  durable medium - the trader can rewrite it and the reader cannot store an
  unchanged copy - so email is what discharges this, and an in-app banner would
  not be. That is why there is no banner.
- **A personal data breach the customer has to hear about.** Article 34 GDPR
  requires communicating directly to each affected person, without undue delay,
  where the breach is likely to result in a high risk to their rights and
  freedoms. Public communication substitutes only where individual contact would
  involve "disproportionate effort", which is not the case here.

**Deploying a notice is what sends it.** The text lives in `LEGAL_NOTICES` in
**packages/web/convex/model/legal.ts**; there is deliberately no console button and
no free-text field, because a textarea that mails every customer at once is the
wrong place for reviewed prose with legal consequences. A cron picks the entry up
within 15 minutes. See [Operations](../operations.md), "Publishing a legal
change", for the order of the two deploys.

Three properties make it safe to re-run:

- a notice reaches the accounts that existed when its send **began**, from a
  cutoff recorded once on the notice row, so a signup arriving mid-send is not
  half-notified and a later signup is never told about a change that predates it;
- one row per recipient, so a second run skips everyone already recorded; and
- the notice is sent as one message per person, because a durable medium is
  information "addressed personally to that person" - and because fifty
  recipients on one message would disclose fifty customers to each other.

Only a finished account deletion is excluded, and only because its address has
already been replaced with a `@deleted.invalid` placeholder. Suspended accounts,
accounts midway through deletion, and staff accounts are all included: every
exclusion here is a person who was not told.

There is no unsubscribe link. This is a transactional message in every regime
that draws the line - CAN-SPAM lists notification of "a change in the terms or
features of" an account as a transactional or relationship message, and ePrivacy
consent rules govern direct marketing, which this is not. An opt-out would invite
a customer to waive a notice we are obliged to give them.

The record is the point of the whole mechanism. **legal_notices** holds the
notice as sent - the subject and text copied in rather than resolved back through
today's source, which could only say what the notice _would_ say now.
**legal_notice_recipients** holds one row per person: address, Resend id, queue
state, and the delivery event. Both are kept for six calendar years (see
[Maintenance](../maintenance.md#retained-deleted-data)), because the obligation
is owed per person and the burden of proof is ours. Account deletion replaces the
address and keeps the rest.

Failures are loud, in proportion to what silence would cost:

| Condition                              | Severity     | What it means                                                        |
| -------------------------------------- | ------------ | -------------------------------------------------------------------- |
| No **RESEND_ACCOUNTS_FROM** configured | **critical** | Nothing was sent to anyone, and nothing was recorded as sent         |
| A recipient could not be queued        | **critical** | Named customers have not been told; re-run once the sender is fixed  |
| `email.bounced`, `email.failed`        | **critical** | One named customer has not been told. Reaching them is a manual step |
| `email.complained`                     | **critical** | Delivered, but the shared customer domain's reputation took the hit  |

## Setup from nothing

Repeat these steps for every Convex deployment that should deliver alerts.

1. Create a Resend account and a sending-access API key. Set
   **RESEND_API_KEY** on the Convex deployment.
2. For development, use the senders in `.env.example.convex.dev`. They point at
   Resend's shared test address, which only delivers to the Resend account
   owner - that restriction is what makes rehearsing a legal notice safe, since
   a row is recorded per seeded account while only your own copy arrives.
3. For production, verify the marketing domain in **Resend → Domains → Add
   Domain** and set all three senders to addresses on it - see
   [Sending identity](#sending-identity-and-when-it-changes) for the addresses
   and for the volume at which this becomes several domains instead.

   Resend generates the exact records; add them verbatim in Cloudflare DNS, left
   **DNS-only / unproxied**, then wait for Resend to mark the domain
   **Verified**:
   - **DKIM:** a `TXT` record at `resend._domainkey.<domain>` holding the `p=…`
     public key.
   - **SPF:** a `TXT` record (`v=spf1 include:amazonses.com ~all`) plus an `MX`
     record on the return-path host Resend names, which catches bounces. Resend
     sends through AWS SES, so the MX target is
     `feedback-smtp.<region>.amazonses.com`; copy the region shown.
   - Nothing else. The anti-spoofing record (`DMARC`) and the inbox-logo record
     (`BIMI`) belong to the zone rather than to Resend, and both are set up in
     [Cloudflare](cloudflare.md), "Proving mail is really from you". Resend will
     tell you DMARC is missing; that page is where you fix it.

   The return-path records sit on their own host beneath the domain rather than
   on the domain itself, which is why verifying the apex does not disturb the
   `MX` and SPF that Cloudflare Email Routing puts there for inbound support mail
   ([Cloudflare](cloudflare.md), "Support mail"). The two coexist because they
   are different hostnames; nothing has to be merged.

   The local part is cosmetic to Resend; only the domain has to match a verified
   identity. It is not cosmetic to a recipient, which is why all three differ -
   see [Sending identity](#sending-identity-and-when-it-changes). None of the
   three is where a reply should go: every customer message sets a `Reply-To` of
   the support address instead.

4. In Resend, create a webhook for **<CONVEX_SITE_URL>/resend/events**. Enable
   **email.sent**, **email.delivered**, **email.delivery_delayed**,
   **email.bounced**, **email.complained**, **email.failed**,
   and no engagement-tracking events. Set its signing secret on the Convex
   deployment as **RESEND_WEBHOOK_SECRET**. Review the supported event list when
   upgrading the Convex Resend component.
5. Ensure at least one non-suspended **admin** exists. The console reports zero
   recipients otherwise.

## Replying as the support address

The support address is received through Cloudflare Email Routing, which cannot
send ([Cloudflare](cloudflare.md), "Support mail"). Replying as it therefore
needs an SMTP relay - a consumer Gmail account cannot send as an address on a
domain Google does not host without being given one - and Resend is already in
the stack. Two things to know before starting.

**1. It reuses the domain the application already verifies, so it costs nothing
extra.** SMTP accepts a `From` only on a domain verified in the Resend account,
and the marketing domain is that domain - it is where the application's own senders live too (see
[Resend](resend.md), "Sending identity"). No second verification, no second
domain slot, no extra DNS. That is a consequence worth noticing rather than a
coincidence: verifying the apex is what lets one verified domain carry both the
automated senders and the human address printed on the Terms.

If the application's senders are ever moved onto their own subdomains as volume
grows, the apex stays verified and keeps this address. Human correspondence is
precisely the traffic that should remain on it.

**2. Replies become Resend's data.** Mail relayed through SMTP is recorded in
Resend's own emails table like any other send. That puts the content of support
correspondence - which is customer prose, and may contain anything a customer
chooses to say - through a processor the Privacy Policy describes as carrying
alerts, box notices and legal notices only. That description has to cover support
correspondence before this is used with real customers.

**Relay settings**, from Resend's SMTP documentation:

| Setting  | Value                                                      |
| -------- | ---------------------------------------------------------- |
| Host     | `smtp.resend.com`                                          |
| Port     | `587` or `2587` (STARTTLS); `465` or `2465` (implicit TLS) |
| Username | `resend` - the literal word, not an address                |
| Password | A Resend API key with sending access                       |

Prefer `587`. The `2587`/`2465` pair exists for networks that block the standard
ports, and `25` is offered but should not be used from a client.

**Setting it up in Gmail.** Under **Settings -> Accounts and Import -> Send mail
as -> Add another email address**:

1. Enter the name customers should see - `Composery Support`, and the email - `support@composery.io`.
2. Leave **Treat as an alias** ticked. It tells Gmail the two addresses are the
   same person, which is what makes the reply behaviour in step 5 available.
3. Give the relay settings above. Gmail connects immediately, so a wrong key or
   port fails here rather than silently later.
4. Gmail mails a confirmation code to the address. It arrives through Email
   Routing, which makes this the first end-to-end proof that receiving works - if
   it never arrives, the fault is in Email Routing rather than here.
5. Afterwards, turn on **Reply from the same address the message was sent to** on
   the same settings page. Without it, a reply to a forwarded support message
   goes out from the personal inbox by default - the exact failure this section
   exists to prevent, and a silent one, because the sender only ever sees the
   thread.

**Why this authenticates.** The message is DKIM-signed by the verified apex, so
the signing domain and the `From` domain are the same and DMARC passes on
alignment. That is also what stops a recipient's client annotating the message as
sent _via_ somewhere else, which a relay signing under its own domain would
produce.

**Volume.** Resend applies the same rate limit to SMTP as to the API, and the
account's allowances are shared with everything the application sends. Human
replies are negligible against that, but not exempt from it: a day that exhausts
the allowance on notices also stops support replying.

**Check.** Send a test message from the alias to an address outside the domain
and confirm three things - it arrives, it shows `support@composery.io` as the
sender with no "via" annotation, and a reply to it comes back through Email
Routing. Then reply to any forwarded message and confirm the outgoing address was
the role address rather than the inbox's own.

## Launch check

1. Change the checkout toggle in development and confirm one **staff_alerts**
   row is created, one email reaches every intended admin, and the webhook
   advances its delivery event.
2. Change the toggle back and confirm the recovery/state-change alert.
3. Temporarily use an invalid sender in development, trigger an alert, and
   confirm the console exposes the queue problem; restore the sender and confirm
   the retry clears the queue state.
4. Complete a Polar sandbox checkout and confirm Polar sends the customer
   receipt while Resend sends no email about the payment.
5. Suspend a development box from the staff console with a reason, and confirm
   the owner's notice contains that reason and reads the same as the box page.
   Unsuspend it and confirm the second notice.
6. Delete a development box and confirm its owner receives one deletion notice
   naming why, that its `Reply-To` is the support address, and that the box's
   event log holds a matching `box.owner_emailed` entry.
7. Rehearse a legal notice in development. Add a throwaway entry to
   `LEGAL_NOTICES`, push, and confirm within 15 minutes that one
   **legal_notices** row holds the text verbatim, that
   **legal_notice_recipients** holds one row per non-deleted account with a
   **distinct** `email_id` each, and that pushing again adds no rows. Distinct
   ids are the check that matters: one shared id would mean one message to many
   recipients, which is neither a durable-medium notice nor something you want
   disclosing your customers to each other. Remove the entry and its rows
   afterwards.
8. Clear **RESEND_ACCOUNTS_FROM** in development, re-run the sweep, and confirm the
   console reports the missing legal-notice sender on its own line, a
   **critical** alert is raised, and **no** recipient row was written - nothing
   may be recorded as told while nothing was sent.
9. Before the first real legal notice, establish what the account's daily send
   cap does to one. A notice is one message per account holder in a burst, so a
   fleet larger than the cap is the first thing that will meet it. The component
   queues and claims to honour Resend's rate limits, which should spread the
   burst rather than fail it - but **that is a claim about a library, not an
   observation of this deployment**, and the failure it would hide is the worst
   one this system has: customers recorded as told who were not. Send a notice to
   a rehearsal fleet larger than the daily cap, then confirm every recipient row
   ends at a delivered event rather than sitting at `queued` for ever or landing
   in `queue_failed`.

Official references:

- https://resend.com/docs/dashboard/domains/introduction
- https://resend.com/docs/dashboard/api-keys/introduction
- https://resend.com/docs/dashboard/webhooks/introduction
- https://resend.com/docs/send-with-smtp

Sender requirements, which change and should be re-read rather than trusted from
this page:

- Gmail: https://support.google.com/a/answer/81126
- Microsoft consumer (Outlook.com, Hotmail, Live):
  https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730
