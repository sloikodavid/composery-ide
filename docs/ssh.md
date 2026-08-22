---
title: SSH
description: Reach a Composery instance the way you reach any server - shell, file transfer, tunnels, and your desktop editor's remote mode.
---

Composery runs an SSH service, so an instance works like an ordinary server: a shell,
`scp` and `sftp`, `rsync`, `git push`, `ssh -L`/`-R`/`-D` tunnels, and the remote modes of
desktop editors and AI coding tools. You land as `user`, in the same filesystem the
editor's terminal shows, with `sudo` available.

This is not the [API](api.mdx). That is a key-authenticated HTTP surface for driving the
editor's terminals; this is SSH, with its own credential and its own namespace. An
instance can run either without the other.

To point Claude Desktop or ChatGPT Desktop at an instance, see
[AI agents](ai-agents.md) - this page is the mechanism underneath it.

## Reaching it

sshd listens on port **22 inside the container** and reaches nothing until your deployment
publishes it. Publishing is the opt-in, so leaving SSH enabled costs nothing until you
decide otherwise. For a self-hosted instance, see
[Self-hosting](self-hosting/index.md#ssh) for the compose mapping.

`COMPOSERY_DISABLE_SSH` stops the service entirely.

## Certificates, not a pile of keys

An instance signs SSH certificates with **its own certificate authority**, generated on
first boot. The authority is per instance, so a certificate is valid on the instance that
issued it and nowhere else - there is no fleet key that would make one enrollment open
every machine.

Each certificate carries a **serial**. Revoking one writes that serial into the instance's
revocation list, which is how a single laptop or agent loses access without disturbing
anything else. Certificates also expire, but revocation is the control that matters: it
applies to the next connection rather than waiting for a deadline.

The same authority signs the instance's **host** key. A client that trusts the authority
verifies the host by signature instead of a pinned fingerprint, so a rebuilt instance
stops producing the "REMOTE HOST IDENTIFICATION HAS CHANGED" alarm.

## Managing access

Access is managed **on the instance**, because being able to open the editor is the
authorization - the same boundary API keys use:

```bash
composery ssh enroll --name "my laptop"   # a single-use token, printed once
composery ssh list                        # every certificate, live and revoked
composery ssh revoke <serial>             # effective on the next connection
```

Only the token's hash is stored, so nothing on the volume is a usable credential.

On a Composery Cloud instance the same three things are on the box's page under
**Connect over SSH**: it mints a token, shows what is already connected, and
revokes any one of them. That list is read from the instance every time it is
opened rather than kept on the website - a stale list of what can reach your box
is worse than no list, because it is exactly what somebody checks before deciding
they are safe.

If you would rather add a plain public key and skip certificates entirely, that works too:
append it to `~/.ssh/authorized_keys`, or set `COMPOSERY_SSH_AUTHORIZED_KEYS` before the
instance starts. Those are two separate files, so neither can overwrite the other.

## Connecting a machine or an agent

Enrollment is the one step that cannot happen on the instance: a machine that is not yet
trusted asking to become trusted. Mint a token, then redeem it from the machine that will
connect.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/composery -N "" -C composery
curl -fsS "https://<your-instance>/_composery/ssh/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"composery_ssh_...\",\"publicKey\":\"$(cat ~/.ssh/composery.pub)\"}"
```

Generate the keypair on the machine that will connect and send only the public half. The
private key never needs to leave that machine, and nothing here ever returns one.

The reply is **data, not instructions** - it is meant to be read, never executed. Save
`certificate` beside the private key as `~/.ssh/composery-cert.pub`, add `authority` to
`~/.ssh/known_hosts` as an `@cert-authority` line for the host, and add a `Host` entry:

```text
Host composery
  HostName <your-instance>
  User user
  Port 22
  IdentityFile ~/.ssh/composery
  CertificateFile ~/.ssh/composery-cert.pub
  IdentitiesOnly yes
  ServerAliveInterval 30
```

That entry is the thing that makes an instance usable. Once it exists, `ssh`, `scp`,
`rsync`, `git`, and every desktop editor's remote mode read it and need nothing further.

If a token is refused, mint another - they work once and expire quickly, which is what
keeps one seen in a chat log worthless by the time anybody reads it.
