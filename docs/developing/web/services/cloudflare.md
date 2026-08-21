---
title: Cloudflare
description: Delegate both domains from Namecheap, serve the website, and automate box DNS.
---

Namecheap remains the registrar. Cloudflare becomes the authoritative DNS
provider for both domains:

- `composery.io`: Vercel website, Clerk records, Resend sending records, and
  Email Routing for support mail.
- `composery.cloud`: DNS-only records for hosted boxes.

Keeping DNS in one provider avoids editing records in the wrong dashboard.

## Delegate the domains from Namecheap

Add each apex domain as a separate Cloudflare Free zone. Review the records
Cloudflare imports, then copy the two assigned Cloudflare nameservers.

For each domain in Namecheap:

1. Open **Domain List -> Manage -> Nameservers**.
2. Choose **Custom DNS** and enter exactly the two Cloudflare nameservers.
3. If DNSSEC is enabled in Namecheap, remove the old DS record before changing
   nameservers. Re-enable DNSSEC from Cloudflare after the zone is Active.
4. Wait for Cloudflare to show **Active** before relying on its records.

The domains stay registered and renewed at Namecheap. After delegation, edit
DNS only in Cloudflare.

## Website zone: composery.io

Add both `composery.io` and `www.composery.io` to the Vercel project. Run
`vercel domains inspect` for each and create the exact A/CNAME/TXT records it
shows in Cloudflare. Keep the Vercel records **DNS only** unless Vercel's current
instructions explicitly say otherwise. Configure the apex to redirect to
`https://www.composery.io` in Vercel so there is one canonical origin.

Clerk and any Vercel ownership checks also publish records in this zone, and so
does Resend for each domain it verifies (see [Resend](resend.md)). Copy
provider-generated values exactly; do not reuse examples from this repository
because provider-specific targets can change.

## Support mail

`support@composery.io` is the address printed on the Terms and the Privacy
Policy, the one a customer exercises a data-subject right through, and the
`Reply-To` on every email Composery sends a customer. It is a role address on
purpose: all three of those outlive whoever reads them today, so none may name an
individual's inbox. It is defined once, in `packages/shared/index.ts`
(`OWNER.email`), and everything else derives from it.

Receiving and replying are two separate problems with two separate providers,
because the one that receives cannot send. Neither costs a mailbox.

### Receiving

**Cloudflare Email Routing** forwards the address to an inbox you already own,
with no mailbox to buy and no per-address fee.

Email Routing owns the apex `MX` and refuses to enable while any other `MX` holds
it, reporting _"Existing non-Cloudflare MX records conflict with Email Routing"_.
A zone created by importing an existing domain can arrive holding exactly that,
because Cloudflare copies in whatever the registrar was publishing. Namecheap's
free email forwarding is the case to expect here, since that is where these
domains are registered: it publishes `MX` records at
`eforward1`-`eforward5.registrar-servers.com` together with an SPF `TXT` of
`v=spf1 include:spf.efwd.registrar-servers.com ~all`. If the zone has them,
delete them in Cloudflare's **DNS -> Records**; if it does not, there is nothing
to do and Email Routing will enable directly.

Delete the registrar's SPF `TXT` as well rather than leaving it beside the one
Email Routing publishes. It authorises forwarders that will no longer be carrying
mail for the domain, and more than one SPF record on a name is a permanent error
that fails the check outright instead of falling back to either. Leave `TXT`
records that are not mail alone - domain-ownership proofs for search consoles and
the like sit at the apex too and are unrelated.

**Do this in Cloudflare and nowhere else.** A registrar's own mail settings work
only while its own nameservers are authoritative, so with the domain delegated it
will refuse to edit forwarding and offer instead to take DNS back - Namecheap
words this as _"transfer DNS back to Namecheap BasicDNS to manage the records
here - Change DNS Type"_. **Never take that offer.** It moves authority for the
zone to a registrar-side zone that holds none of the Vercel or Clerk records, and
the website and sign-in stay down until it is undone.

Nor is it needed. A delegated registrar publishes nothing for the domain and so
cannot re-add what you delete; the setting it will not let you reach governs
records it no longer serves. The imported records are a different matter: stale
as a copy, but live as DNS, and they point at forwarding servers that really do
run. Where a forwarding rule was configured before delegation, mail to that
address is still being delivered through them, and deleting the records is what
stops it - for the few minutes until Email Routing publishes its own `MX`.

Then open **Email -> Email Routing**, verify a destination address, and create a
custom address `support@composery.io` pointing at it. Cloudflare adds its `MX`
records (`*.mx.cloudflare.net`) and an SPF `TXT`
(`include:_spf.mx.cloudflare.net`) to the apex.

That does not collide with Resend, even though Resend verifies the same domain
for sending: the only `MX` Resend needs is on its own return-path host beneath
it, and its SPF record goes there rather than on the apex (see
[Resend](resend.md)). Different hostnames, so each provider owns records the
other never touches and nothing has to be merged.

### Replying

Email Routing is receive-and-forward only and
[cannot send](https://developers.cloudflare.com/email-routing/postmaster/), so a
reply composed in the destination inbox goes out as that inbox's own address -
which puts a personal address in front of the customer and defeats the point of
a role address. Fixing that needs an SMTP relay, and that is Resend's half of
this: see [Resend](resend.md), "Replying as the support address".

## Proving mail is really from you

Anyone on the internet can send an email that _says_ it is from
`composery.io`. Nothing in the mail protocol stops them - the sender writes the
`From:` line and the receiver believes it. Four DNS records are how a receiving
mail server tells your real mail from a forgery, and they matter more here than
on an ordinary site because this domain carries notices customers are legally
owed.

| Record  | The question it answers                                                      |
| ------- | ---------------------------------------------------------------------------- |
| `SPF`   | Which servers am I allowing to send mail as this domain?                     |
| `DKIM`  | Is this message really from them, and was it altered?                        |
| `DMARC` | What should you do with mail that fails those, and where do I read about it? |
| `BIMI`  | Which logo should you draw next to my name?                                  |

`SPF` and `DKIM` are generated by whoever sends for you and pasted in as-is -
[Resend](resend.md) covers both, and the box below is why they are not enough on
their own. The other two are yours to decide, and are covered here.

> `SPF` and `DKIM` each prove something about a message, but neither says what a
> receiver should do when the proof fails, and neither tells you it happened.
> That is `DMARC`'s job, and it is why a domain with only the first two is still
> spoofable in practice.

### DMARC: what should happen to forgeries

A `TXT` record at `_dmarc.composery.io` that says two things: what a receiver
should do with mail that fails the other two checks, and where to send you a
daily summary of who has been sending as you.

The policy is one word, and you climb it in order:

| Policy         | Means                                    |
| -------------- | ---------------------------------------- |
| `p=none`       | Deliver forgeries as normal, but tell me |
| `p=quarantine` | Put forgeries in the spam folder         |
| `p=reject`     | Refuse forgeries outright                |

Start at `p=none`. Not because forgeries are acceptable, but because the same
check that catches a forger also catches your own mail if a sender is
misconfigured - and at `p=reject` that mail silently disappears instead of
arriving. `p=none` lets you watch for a few weeks, confirm every real sender
passes, and only then tighten.

The daily summaries are what makes that possible, and they are the part people
skip. A DMARC record with no reporting address is a policy of "do nothing"
combined with "tell nobody" - it looks configured and teaches you nothing, so
you can never justify moving off `p=none`.

**You do not have to find somewhere to send them.** In the Cloudflare dashboard,
open **Email → DMARC Management** for the zone. It is free on every plan, it
writes the `_dmarc` record for you including its own reporting address, and it
turns the reports - which arrive as machine-readable XML attachments from every
receiver in the world - into a readable list of who sent as you and whether they
passed. Enable that rather than hand-writing the record.

The runtime zone goes straight to `p=reject` (see below) because it sends no
mail at all, so it has nothing legitimate to break. A domain that does send has
to earn its way there.

#### Alignment, and why the two zones want different settings

DMARC does not just ask whether `SPF` and `DKIM` passed. It asks whether they
passed **for the same domain that appears in the `From:` line** - a forger can
easily pass SPF for a domain they control, so passing alone proves nothing. That
match is called alignment, and `aspf` and `adkim` choose how exact it has to be:
`r` (relaxed, and the default) counts a subdomain as matching its parent, `s`
(strict) demands the identical name.

A domain that sends through a provider almost always wants relaxed. Providers
put the return path - the domain SPF is actually checked against - on a
subdomain of yours, so under strict matching SPF stops counting toward DMARC
entirely and DKIM becomes the only path left. Nothing visibly breaks, which is
what makes it a trap: mail keeps passing until it crosses a mailing list or a
forwarder that invalidates the signature, and then it fails with no second leg
to stand on.

A domain that sends nothing wants strict, because there is no legitimate mail to
disqualify and strict refuses one more class of forgery. So the runtime zone
carries `aspf=s; adkim=s` and a sending domain should not copy it.

### BIMI: your logo beside the message

Once DMARC is at `p=quarantine` or `p=reject`, mail clients can be asked to show
your logo next to the sender name. That needs a `TXT` record at
`default._bimi.composery.io` pointing at a logo file, in a restricted SVG
flavour called SVG Tiny P/S, served over HTTPS.

The catch is the certificate. Gmail, Apple Mail and Outlook only draw a logo
that is backed by a paid certificate proving the mark is yours; Yahoo draws it
without one. A **VMC** requires the logo to be a registered trademark. A **CMC**
drops that but requires a year of documented use of the logo, which a service
that has not launched cannot show. Both are roughly four figures a year.

So: DMARC first, because it is free and needed anyway. The BIMI record and logo
whenever convenient - also free, and it buys Yahoo. The certificate only once
there is a year of use behind the logo and a reason to value that piece of the
inbox at that price.

### Considered and deliberately not set up

Recorded so a later reader knows these were weighed rather than missed.

**MTA-STS and TLS-RPT.** The four records above are about mail leaving as us.
These two are about mail arriving to us: MTA-STS tells senders "always use TLS
to reach me, and refuse to fall back", and TLS-RPT asks them to report when a
connection could not be secured. Cloudflare has no managed support for either -
MTA-STS needs a policy file served over HTTPS at a fixed path, which means
standing up a Worker or Pages project just to host one text file, plus a second
one to receive the reports.

Left out because the exposure is small and specific: it requires an attacker
positioned on the network path between a sender and Cloudflare, downgrading a
connection carrying mail addressed to `support@`. Two things make it worth
revisiting - support mail beginning to carry anything sensitive, or Cloudflare
shipping managed support so it becomes a toggle rather than a service to run.

**A BIMI certificate.** See above - it is a yearly cost gated behind either a
registered trademark or a year of documented logo use.

## Runtime zone: composery.cloud

Production uses `CLOUD_DOMAIN=composery.cloud`; development uses
`CLOUD_DOMAIN=dev.composery.cloud`. Both are subdomains of the same
`composery.cloud` zone and use the same zone id. They must differ so a dev and
production box with the same slug cannot collide.

The runtime domain sends and receives no email, and says so in DNS rather than
just being quiet about it. Remove imported parking and mail records and publish:

| Name     | Type  | Content / mail server                            | Priority | Says                            |
| -------- | ----- | ------------------------------------------------ | -------- | ------------------------------- |
| `@`      | `TXT` | `v=spf1 -all`                                    | -        | Nothing may send as this domain |
| `_dmarc` | `TXT` | `v=DMARC1; p=reject; sp=reject; aspf=s; adkim=s` | -        | Refuse anything that tries      |
| `@`      | `MX`  | `.`                                              | `0`      | This domain accepts no mail     |
| `*`      | `MX`  | `.`                                              | `0`      | Nor does any production box     |
| `*.dev`  | `MX`  | `.`                                              | `0`      | Nor does any development box    |

An `MX` record normally names **the hostname of a server that accepts mail** for
that name, and the priority says which to try first - lower first, and only the
relative order matters rather than the numbers themselves. A zone that receives
mail therefore reads like `route1.mx.cloudflare.net` at some priority, and a
sender walks the list.

The three above name `.`, the DNS root, which is not a server at all. Priority
`0` with a target of `.` is the "null MX" defined by RFC 7505, and it is a
signal rather than a destination: a sender that meets one stops immediately and
reports the address as undeliverable, instead of queueing and retrying for days
against something it assumes is temporarily down. It only works as the **only**
`MX` at that name - a null MX beside a real one is invalid, because the claim
being made is that there is nowhere to deliver.

The wildcards are the ones that matter. A sender with no `MX` to go on falls
back to the address record, and every box **has** one - so without these, mail
addressed to anything at `<slug>.composery.cloud` is delivered at a customer's
own server. Two of them because a DNS wildcard covers a single label:
`*.composery.cloud` matches `<slug>.composery.cloud` and stops there, while
development boxes sit a level deeper at `<slug>.dev.composery.cloud`.

Cloudflare's DNS documentation does not mention null MX either way, so whether
its dashboard accepts a bare `.` in the mail-server field is worth finding out
by typing it rather than by reading. If the form refuses the value, entering the
zone name in full under **Name** instead of `@` is the workaround others report.

Two things that look missing and are not. There is no `SPF` record on any box
name, because `SPF` does not inherit down a zone and one per box is not a thing
anyone can publish - `sp=reject` on the `DMARC` record is what covers them, and
it covers them at every depth. And this zone starts at `p=reject` on day one,
where the website zone must not: a domain that sends nothing has no legitimate
mail to break by refusing everything.

The app creates each box's A and AAAA records. Do not pre-create them. They stay
**DNS only** with automatic TTL because Caddy on the box terminates HTTPS and
must receive ACME traffic directly.

## Runtime API credentials

From the `composery.cloud` zone overview copy **Zone ID** to
`CLOUDFLARE_ZONE_ID`. Create an API token from the **Edit zone DNS** template,
restricted to **Zone / DNS / Edit** on that specific zone, and copy it once to
`CLOUDFLARE_DNS_TOKEN`.

The token and zone id belong only in each Convex deployment. The website zone
does not need an application API token.

## Check

- Namecheap shows Cloudflare's nameservers for both domains.
- Both Cloudflare zones are Active.
- `www.composery.io` serves Vercel and the apex redirects to it.
- Clerk's five production records verify.
- Runtime A/AAAA records are DNS-only and dev uses the `dev` subdomain.
- DMARC Management is on for `composery.io` and its reports name every real
  sender as passing before the policy is tightened past `p=none`.
- The sending domain's DMARC leaves `aspf`/`adkim` at their relaxed default; only
  the zone that sends nothing sets them strict.
- Each `DKIM` key a provider publishes is 2048-bit, or the provider has been
  asked whether it can issue one. RFC 8301 sets the floor at 1024 and that is
  still accepted everywhere, but guidance from the large receivers has moved to
  2048 and providers differ in what they issue by default. Decode rather than
  eyeball it - a 1024-bit key begins `MIGfMA0...` and a 2048-bit one
  `MIIBIjANB...`.
- Mail to `support@composery.io` arrives in the destination inbox. Replying _as_
  it is checked on [Resend](resend.md), which owns that half.

## References

- Cloudflare domain onboarding: https://developers.cloudflare.com/fundamentals/manage-domains/add-site/
- Cloudflare DNS records: https://developers.cloudflare.com/dns/manage-dns-records/
- Cloudflare Email Routing: https://developers.cloudflare.com/email-routing/
- Cloudflare DMARC Management: https://developers.cloudflare.com/dmarc-management/
- BIMI: https://bimigroup.org
- Null MX (RFC 7505): https://www.rfc-editor.org/rfc/rfc7505
- MTA-STS (RFC 8461): https://www.rfc-editor.org/rfc/rfc8461
- TLS-RPT (RFC 8460): https://www.rfc-editor.org/rfc/rfc8460
- Cloudflare API tokens: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- Vercel external DNS: https://vercel.com/docs/domains/set-up-custom-domain
- Namecheap custom nameservers: https://www.namecheap.com/support/knowledgebase/article.aspx/767/10/
