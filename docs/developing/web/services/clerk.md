---
title: Clerk
description: Configure development and production authentication, SSO connections, legal consent, Convex identity, and account deletion.
---

Use separate Clerk development and production instances. Development uses
`pk_test`/`sk_test`; production uses `pk_live`/`sk_live` and the custom
domain `clerk.composery.io`.

## Configure each instance

1. Enable Clerk's **Convex integration**. It provisions the `convex` JWT
   configuration used by `convex/auth.config.ts`.
2. Under **Sessions -> Customize session token**, add:

   ```json
   { "email": "{{user.primary_email_address}}" }
   ```

   Checkout requires the authenticated email claim.

3. Under **Legal**, set:
   - Terms: `https://www.composery.io/terms`
   - Privacy: `https://www.composery.io/privacy`
   - **Require express consent to legal documents**: enabled

   The same public documents may be used by the development instance.

4. Under **SSO connections**, enable the social providers you offer and keep
   email verification on at sign-up. See [SSO connections](#sso-connections).
5. Keep self-service account deletion enabled.
6. Keep **Bot sign-up protection** on. Account lockout and MFA stay at Clerk's
   defaults; turning on the application-wide MFA requirement adds another
   session task to the signed-out path, so re-check the box transaction below
   if you do.
7. Collect:

   | Value                  | Destination                                 |
   | ---------------------- | ------------------------------------------- |
   | Publishable key        | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Next |
   | Secret key             | `CLERK_SECRET_KEY` in Next                  |
   | Frontend API URL       | `CLERK_FRONTEND_API_URL` in Convex          |
   | Webhook signing secret | `CLERK_WEBHOOK_SIGNING_SECRET` in Convex    |

`NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`. Set
`CLERK_AUTHORIZED_PARTIES=http://localhost:3000` locally and
`https://www.composery.io` in production.

## SSO connections

SSO connections, Integrations, and Paths are per-instance: none of them copy
from development to production. Configure the same providers twice.

A development instance borrows Clerk's shared OAuth credentials, so a provider
works there with nothing else set up. Production does not accept those. For
each provider, register an OAuth app on its side, copy the **Authorization
Callback URL** Clerk shows for that connection, then enable **Use custom
credentials** and paste the client id and secret.

Every provider must return a verified email address. `convex/users.ts`
reads the `email` claim and refuses an identity without one. Clerk links a new
social identity into the existing account when the email matches and is
verified, which is why **Verify at sign-up** stays on: the Convex user row is
keyed on the Clerk user id, so a second Clerk identity for the same person
becomes a second, empty account with the same email.

Enabled providers need no code change. `ui/lib/clerk-appearance.ts` already styles
the social buttons, and `/sign-in` is a catch-all route rendering
`<SignIn withSignUp />`, so both flows and their follow-up steps live on that
one path. Legal consent turns the OAuth return into a session task - the
provider redirect lands on a consent step before the app - which that route
renders in place. Do not add a separate sign-up path or an Account Portal
redirect; that breaks the return the same way the force redirect below does.

## Box password authorization

An unconfigured Cloud box starts a short-lived authorization-code transaction
at `/boxes/authorize`. This route uses the existing Clerk session; signed-out
users go through `/sign-in` with an internal `redirect_url`, while signed-in
users return to the box without seeing another prompt. Do not configure a Clerk
force redirect because it overrides the transaction return path.

The code, PKCE challenge, grant, and their lifetimes live in
`convex/instance/auth.ts`; read them there rather than restating them. The raw
password never leaves the box origin, so Clerk only ever proves who owns the
box.

Check both cases when changing Clerk routing:

- A signed-in owner opening a new box returns directly to its password form.
- A signed-out owner signs in or signs up, including any required Clerk session
  tasks, and then resumes the same box transaction.

## Production DNS

Add `clerk.composery.io` as Clerk's production custom domain. Clerk shows five
CNAME records for the frontend API, account portal, mail, and two DKIM keys.
Create those exact records in the `composery.io` Cloudflare zone as **DNS
only**. Do not copy targets from old screenshots or this guide. Propagation can
take up to 48 hours; Clerk offers **Deploy certificates** once every record
verifies, and production keys become usable after it provisions TLS.

## Account deletion webhook

Create a Clerk webhook endpoint:

```text
<CONVEX_SITE_URL>/clerk/events
```

Subscribe only to `user.deleted` and put its signing secret in the matching
Convex deployment. The handler verifies the signature, immediately revokes Polar
subscriptions, deletes boxes and snapshots, releases pending checkouts, and
scrubs the application email. A scheduled retry finishes boxes that are busy.

This webhook is the only entry point, so deleting an account is always the same
operation whoever starts it: a customer removes their own account from the
account portal, and staff remove one by deleting the Clerk user in this
dashboard. Test once in both environments with a disposable account. Removing a
Convex row manually is not account deletion because the Clerk identity would
still exist.

## Check

- Sign-up displays the Terms and Privacy acceptance, including after an SSO
  redirect.
- Each enabled provider signs in on production with custom credentials, and
  signing in with a provider whose email already has an account lands on that
  account rather than a new one.
- The session identity contains `email`.
- Convex accepts an authenticated request.
- Deleting a disposable Clerk user reaches `deletion_finished_at` in Convex.

## References

- Clerk with Convex: https://clerk.com/docs/integrations/databases/convex
- Clerk legal compliance: https://clerk.com/docs/guides/secure/legal-compliance
- Clerk social connections: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/overview
- Clerk account linking: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking
- Clerk production deployment: https://clerk.com/docs/guides/development/deployment/production
- Clerk custom domains: https://clerk.com/docs/guides/development/custom-domains/overview
- Clerk webhooks: https://clerk.com/docs/guides/development/webhooks/overview
