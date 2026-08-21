---
title: Polar
description: Set up the Polar sandbox (dev) and production organizations, products, and webhook for billing.
---

Use the Polar sandbox (`sandbox.polar.sh`) for development and Polar production
(`polar.sh`) for production. Set up each the same way; sandbox values go on the
dev [Convex](convex.md) deployment, production values on the prod deployment.

1. Create or select the organization.
   In production, complete Polar's account review and enter the real supplier
   identity and support contact: David Sloiko, trading as Composery, and
   `support@composery.io`. Polar is the merchant of record and reseller, but
   Composery remains the supplier under the Terms.
2. Create an Organization Access Token (Settings -> Developers -> New Token) with
   these scopes (required by `@convex-dev/polar`):
   - `products:read`, `products:write`.
   - `subscriptions:read`, `subscriptions:write`.
   - `customers:read`, `customers:write`.
   - `checkouts:read`, `checkouts:write`.
   - `checkout_links:read`, `checkout_links:write`.
   - `customer_portal:read`, `customer_portal:write`.
   - `customer_sessions:write`.
   - `orders:read`.
   - `refunds:read`, `refunds:write`.

   Copy it -> `POLAR_ORGANIZATION_TOKEN`. Set `POLAR_ENVIRONMENT=sandbox` for dev
   or `production` for prod; it selects which Polar API the component talks to and
   is the one Polar value with a fail-safe default of `sandbox`
   (`convex/billing/polar.ts`).

3. Under Settings -> Payments, set the organization's default tax behavior to
   **Exclusive**. Polar fixes the billing interval on each product, so a plan
   sold on two intervals is two products - one product per (plan, interval)
   pair, four in total:
   - **Box Air - Monthly**: recurring monthly, fixed.
   - **Box Air - Annual**: recurring yearly, fixed.
   - **Box Pro - Monthly**: recurring monthly, fixed.
   - **Box Pro - Annual**: recurring yearly, fixed.

   The annual products are displayed as a monthly figure on the pricing page.
   Give all four the same accurate hosted-box description, Terms link, Privacy
   link, and benefits, differing only in the machine each plan promises -
   `convex/model/box/plan.ts` is what that machine actually is, and the pricing page
   prints it from there. Duplicating a published product is the safest way to
   create the next one, then change its plan wording, billing interval, and
   price before publishing. Open each product and copy its **Product ID** (not
   its price ID):
   - Box Air Monthly -> `POLAR_BOX_AIR_MONTHLY_PRODUCT_ID`.
   - Box Air Annual -> `POLAR_BOX_AIR_ANNUAL_PRODUCT_ID`.
   - Box Pro Monthly -> `POLAR_BOX_PRO_MONTHLY_PRODUCT_ID`.
   - Box Pro Annual -> `POLAR_BOX_PRO_ANNUAL_PRODUCT_ID`.

   All four are read by `convex/billing/polar.ts`, which also reads a product ID
   back to its (plan, interval) pair - the inverse is what lets a paid order be
   fulfilled as the plan it was actually paid for, and what lets the hourly sweep
   notice a subscription that has drifted. Checkout receives only the chosen
   plan's two product IDs, with the pricing-page choice selected by default, so
   a customer can reconsider monthly vs annual in checkout but cannot leave it
   having bought a different plan than the one their slug reservation was
   admitted for. These are per-deployment values, because sandbox and production
   products have different IDs.

   All four must be set. Selling fails closed on a missing one (`requiredEnv`),
   while the hourly reconciliation reads them tolerantly and raises a staff
   warning per box whose subscription it cannot recognise, rather than aborting
   the sweep or passing over it. A paid order against an unrecognised product is
   the same fault caught earlier and costs a customer money, so that one is a
   critical alert and an automatic revoke and refund.

4. Create one organization custom field (Settings -> Custom Fields), attach it
   to **all four Box products**, and make it a **required checkbox** on each:
   - Slug `composery-terms-v1`.
   - Label `I agree to the Composery Terms of Service.`
   - Help text linking to `https://www.composery.io/terms`.

   Polar prevents checkout confirmation until a required checkbox is checked,
   and copies the value to the Order and Subscription. The webhook also checks
   the value before fulfillment; a paid order without it is revoked and fully
   refunded. Do not change a versioned slug's meaning in place. Create a new
   field and update `convex/model/legal.ts` when the Terms acceptance changes.

5. Enable **Allow multiple subscriptions per customer** in the organization
   subscription settings. Polar disables this by default, but one Composery
   user is allowed to own multiple boxes and each box has its own subscription.
   There is intentionally no one-box-per-customer application limit.

6. In the customer portal settings, **leave on only what Composery actually
   sells.** The portal offers a capability per thing Polar can model, and each one
   it shows for something this product does not have is a control a customer can
   act on to no effect. Composery sells one fixed recurring product per box: no
   seats, no meters, and no plan a box can move to. So switch off **subscription
   plan changes**, **seat management**, and **metered usage**, and apply the same
   rule to any capability Polar adds later - it stays off until something here
   sells it.

   Everything that is about the billing relationship stays on: invoices, receipts,
   payment method, cancellation, and **email edits**. That last one is worth saying
   out loud because it looks like the others and is not. Polar owns billing
   correspondence and Clerk owns identity (see `convex/notice/owner.ts`), so the
   address a customer sets here is where their receipts go, while product and
   identity mail keeps going to their login. It cannot desync anything either: a
   Polar customer is linked by Clerk user id and `polar_customer_id`, never by
   email, and the component's `getUserInfo` is stubbed to throw so nothing resolves
   a user from Polar's side at all. The two addresses simply differ, which is
   usually the point.

   Plan changes are the one where this is a correctness rule rather than a
   tidiness one. A box stays on the plan it was bought on, so a customer who used
   a portal switch would be rebilled for something their box never becomes, and
   Polar provides no way to gate or confirm a change before charging for it -
   which is why the answer is to not offer it rather than to validate it. If it is
   enabled anyway and a subscription drifts onto another plan's product, the
   hourly reconciliation reports it as a staff warning and takes no action.

7. Under Customer notifications, keep Polar's order, subscription,
   cancellation, revocation, renewal, and failed-payment emails enabled. Polar
   owns routine billing mail and links customers to its hosted portal. Do not
   disable these in favor of Resend: selecting supplier-managed communications
   makes Composery responsible for sending the notices Polar would have sent.

8. Create a webhook (Settings -> Webhooks -> Add Endpoint). Set the URL to the
   matching deployment's `<CONVEX_SITE_URL>/polar/events` (the Site URL from the
   [Convex](convex.md) step). Copy the signing secret ->
   `POLAR_WEBHOOK_SECRET`. Enable:
   - App logic: `order.paid`, `order.refunded`, `subscription.revoked`,
     `checkout.updated`, `checkout.expired`.
   - Component sync: `product.created`, `product.updated`, `subscription.created`,
     `subscription.updated`.

   Nothing else. `subscription.updated` is Polar's catch-all, fired alongside
   every state change including `active` and `revoked`, and the Polar component
   persists it for us - so the granular twins are events no handler reads, and
   an enabled event nothing handles reads as coverage this deployment does not
   have.

9. Copy the organization **slug** (Settings -> Organization, the handle shown in
   your dashboard URL) -> `NEXT_PUBLIC_POLAR_ORGANIZATION_SLUG`, and set
   `NEXT_PUBLIC_POLAR_ENVIRONMENT` to `sandbox` (dev) or `production` (prod).
   These are frontend-plane vars read by `ui/lib/dashboards.ts` so the staff
   console can deep-link a box to its Polar customer and subscription; set them
   in the Next env (local `.env.local` and [Vercel](vercel.md)), not on the
   Convex deployment. They are non-secret, so the console action simply hides
   itself when the slug is absent.

Checkout success URLs are built from `WEBSITE_ORIGIN`, so that var on the same
[Convex](convex.md) deployment must point at the matching website before you
test checkout.

The pricing page defaults to annual billing and asks for the plan first: each
plan card's **Continue** button opens a dialog that asks for the slug, so
choosing a plan and naming the box are two separate questions rather than one
control that means nothing until the other is filled in. The chosen plan,
interval, and slug all survive the round trip through sign in. The slug is
checked against the shared box namespace before checkout, and the chosen
product is sent first in Polar's checkout product list.

That list holds every product Composery sells, not only the chosen plan's two
intervals, so the customer can change plan or billing interval before paying -
and can change either one afterwards from the portal. Polar fixes a checkout's
product list when the session is created and gives no way to widen it or to void
the session, while Composery holds one reservation per slug for as long as the
checkout lives. A narrower list therefore makes a reservation reopened on the
other plan unsellable, which Polar answers with a 422.

The plan is read back rather than assumed. The box is created on the plan of the
product the order was actually paid for, and the reservation's own plan - which
is what capacity admission counts snapshot slots against - follows the checkout's
current selection through the `checkout.updated` webhook.

## Billing and box lifecycle

Polar treats refunds and subscriptions as separate operations. Refunding a
subscription order does not end the subscription, and revoking a subscription
does not refund an order. Composery therefore applies these rules:

| Event                                                                                           | Money                                                                                             | Subscription and box                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Customer cancels in the Polar portal                                                            | No automatic refund                                                                               | `cancel_at_period_end` stays active through the paid period; the box is removed after the subscription ends.                             |
| Staff or account deletion revokes immediately                                                   | No automatic refund                                                                               | Access ends now; `subscription.revoked` starts box deletion. Refund separately only when agreed, required by law, or directed by Polar.  |
| Partial order refund                                                                            | Polar returns that net amount and prorated tax; Polar fees remain charged to Composery            | Subscription and box remain active.                                                                                                      |
| Full cumulative order refund                                                                    | Polar returns the remaining refundable net amount and tax; Polar fees remain charged to Composery | `order.refunded` makes Composery revoke the subscription, which removes the box.                                                         |
| Paid event arrives after its capacity reservation ended and no complete package remains         | Full remaining refundable amount                                                                  | Composery records the order, revokes the subscription, and refunds without creating an unallocated box.                                  |
| Paid Box order lacks Terms acceptance, a matching checkout intent, or a product Composery sells | Full remaining refundable amount                                                                  | Composery alerts staff, revokes, and refunds without starting fulfillment.                                                               |
| Initial box fulfillment fails after workflow retries                                            | Full remaining refundable amount                                                                  | Composery revokes first, refunds the paid order, and removes any server, DNS, IP, credentials, and snapshots created for the failed box. |
| Snapshot capture fails                                                                          | No subscription refund                                                                            | Only the snapshot operation fails; the running box and subscription continue.                                                            |

`order.paid` stores the exact first order id before provisioning starts. A later
catalog price change cannot affect a fulfillment-failure refund: the code asks
Polar for that order's current `refundable_amount` and refunds all of it. Polar
automatically refunds the associated tax. A pending refund makes the webhook or
workflow retry; stable metadata prevents a duplicate refund.

An active checkout holds one complete package in Composery's local capacity
accounting. A late paid webhook for an expired or released checkout must
atomically reacquire capacity and its slug before conversion. The paid order is
retained even when reacquisition fails, so the revoke/refund is auditable and
idempotent. See [Operations](../operations.md#capacity-and-paid-checkout).

This is not a blanket customer-controlled free-compute window. Polar provides
first-tier refund, cancellation, payment, and chargeback support; its Buyer
Terms allow refunds to be denied for fraud, abuse, misuse, or non-compliance
where the law permits. Composery supplies product/delivery support and must give
Polar requested usage and complaint information within 72 hours. If the paid
box cannot be delivered, Polar's Buyer Terms identify replacement or refund as
the remedy, and Polar's supplier terms require access through the paid period or
a pro-rated refund when the product is unavailable. The code chooses the
customer-safe full refund only for failed **initial** delivery because no usable
period was supplied.

Polar may also issue a refund or cancel a transaction itself to prevent a
chargeback or comply with law. Keep `order.refunded` enabled so a full refund can
never leave an independently billed box running. Handle customer complaints and
refund requests in Polar rather than paying the customer outside Polar.

## References

- Polar merchant of record: https://polar.sh/docs/merchant-of-record/introduction
- Polar account review: https://polar.sh/docs/merchant-of-record/account-reviews
- Polar products and billing intervals: https://polar.sh/docs/features/products
- Polar checkout sessions: https://polar.sh/docs/features/checkout/session
- Polar webhook events: https://polar.sh/docs/integrate/webhooks/events
- Polar custom fields: https://polar.sh/docs/features/custom-fields
- Polar refunds: https://polar.sh/docs/features/refunds
- Polar subscriptions and multiple-subscription setting: https://polar.sh/docs/features/subscriptions/introduction
- Polar subscription cancellation, revocation, and plan changes: https://polar.sh/docs/features/subscriptions/manage
- Polar proration on subscription changes: https://polar.sh/docs/features/subscriptions/proration
- Polar Buyer Terms: https://polar.sh/legal/checkout-buyer-terms
- Polar supplier terms: https://polar.sh/legal/master-services-terms
