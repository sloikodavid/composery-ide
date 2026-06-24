# Composery SSH

Builtin extension that registers `composery.connectOverSsh`, the guided front for
`composery ssh enroll` (see `docs/ssh.md`).

It asks what is connecting, where this instance is reached, and on which port;
mints a single-use enrollment token through the CLI; and opens the resulting setup
prompt as a document to copy into an AI agent. The CLI remains the only writer of
the enrollment store, and anyone who can run this command can already open the
editor's terminal, so the authorization boundary is unchanged.

`prompt.js` is **generated** from `packages/shared/ssh.ts` by
`packages/shared/scripts/sync.mjs` - do not edit it by hand, and run
`pnpm fix:assets` after changing the prompt. The website renders the same text
from the same source, so a hand-written copy here would drift silently: both
surfaces would go on producing a prompt that worked.

The address is asked for rather than detected. The editor is reached through
whatever proxy, port mapping or domain the deployment put in front of it, and none
of that is visible from inside the container. On a cloud instance
`COMPOSERY_CLOUD_ORIGIN` supplies the default.
