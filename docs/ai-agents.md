---
title: AI agents
description: Connect Claude Desktop or ChatGPT Desktop to your Composery and let it work in the machine, not beside it.
---

Composery runs an [SSH](ssh.md) service, so an instance is a machine an AI agent
can be pointed at. The agent runs **in** it: your files, your terminal, your
installed tools, your running services - not a copy of them, and not a sandbox that
disappears.

Two desktop applications can take an SSH host and work in it today: **Claude
Desktop** and **ChatGPT Desktop**. Both read your `~/.ssh/config`, so once an
instance has an entry there it appears in each of them.

Everything else that speaks SSH reaches an instance too - a terminal, `scp`,
`rsync`, `git`, JetBrains Gateway, a desktop editor's remote mode. Those are not
special-cased here; they need no instructions beyond a working `ssh` command.

## The fast way

On a Composery Cloud instance, open your box's page and choose **Connect
remotely**. In a self-hosted editor, run **Composery: Connect Over SSH** from the
File menu or the command palette.

Either one gives you a prompt to paste into the agent. It generates its own
keypair on your machine, asks the instance for a certificate, writes the
`~/.ssh/config` entry, and connects itself. You never handle a private key, and
the only secret in the prompt is a token that works once and expires in minutes.

## The manual way

Add your public key to the instance first - `~/.ssh/authorized_keys` from the
editor's terminal, or `COMPOSERY_SSH_AUTHORIZED_KEYS` before it starts - then add
an entry to your own `~/.ssh/config`:

```text
Host composery
  HostName your-instance.example.com
  User user
  Port 22
  IdentityFile ~/.ssh/composery
  IdentitiesOnly yes
  ServerAliveInterval 30
```

Check it with `ssh composery true` before going near either app. Both of them
read this file, so an alias that does not work in a terminal will not work in
them either.

### Claude Desktop

Settings → **Compute** → **SSH hosts** → **Add SSH host**, then pick the alias.
The address, user, port and any `ProxyJump` come from your `~/.ssh/config`;
`User`, `Port` and the identity file can be overridden under Advanced settings.

Claude Desktop installs Claude Code on the instance itself the first time you
connect - you do not install it, and the editor's own **Set Up an AI Coding
Agent** card is not a prerequisite. The remote machine has to run Linux or macOS,
which a Composery instance does.

The host notes field is worth filling in. Claude reads it before its first job, so
this is where to say what the instance already has and what it may install.

### ChatGPT Desktop

Settings → **Connections**, add or enable the SSH host, then choose a remote
project folder. The connection starts and manages a Codex app server on the
instance over SSH, and the session then uses that machine's projects, files,
credentials and tools rather than your laptop's.

## Why a persistent machine matters here

An agent working over SSH keeps running when you close the lid. Start a long
job, disconnect, and reconnect later to the same instance with the same processes
and the same state - `tmux` is installed for exactly this. That is the difference
between a computer you own and a session that ends with the tab.

Revoking access is one line, and it takes effect on the next connection:

```bash
composery ssh list
composery ssh revoke <serial>
```

On Composery Cloud the same list and its Revoke buttons are in the **Connect
remotely** dialog.
