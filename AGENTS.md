# Conventions

Decisions already made. Reasons appear only where the rule is counterintuitive or
where the why prevents a wrong repair. Depth: `docs/developing/`.

A rule here solves a specific problem - check it is yours before applying it. A
rule that manages unavoidable duplication never justifies creating some.

## Working here

- `pnpm install <package>@latest`. Never hand-edit package.json.
- Every version pin needs a Renovate path or a stated reason it cannot have one:
  actions `@<sha> # vX.Y.Z`, Docker `tag@digest`, bare `ARG` a `# renovate:`
  comment. Some stay unmanaged on purpose (apt, runner labels). See
  `renovate.json`.
- `tmp/` for scratch and artifacts. Gitignored.
- `whitelist.jsonc` is the generated source-unit baseline and the only check on
  the vocabulary this repository accepts. **A flagged unit is a question about
  the source, never about the list.** Growing the list is how the check stops
  working, so `pnpm fix:whitelist` prunes and sorts but refuses new entries: read
  the unit, then fix the typo, the accidental name, or the word that repeats a
  word the list already has. Only a word carrying a meaning no listed word carries earns
  `node scripts/whitelist.mjs --write --accept-new`, and its reason belongs in
  the commit text. The same rule owns `.whitelistignore`: it hides contents we do
  not write (generated, vendored, binary), never a file with an awkward word in
  it. CI checks, never rewrites.

## Duplication

One value in two places: **remove the copy, else derive it, else pin the pair
with a test** - in that order. The test is a last resort; it makes the
duplication permanent and invites satisfying the test instead of asking why
there are two copies. It earns its place only where an external tool must read
the copy.

No abstraction for confirmed single-use code.

## Naming

- One name per concept, the plainest: Create (not Provision/Spawn), Delete (not
  Erase/Destroy), Start (not Open/Boot), Stop (not Close/Halt), Finish (not
  Complete/End), Type (not Mode/Kind), Contents (not Material), Index (not
  Main). Where an external API forces its word, keep theirs at the boundary,
  ours inside.
- An action is named for what it acts on: a whole thing takes the bare verb
  (`repair`, `reset`), an attribute takes verb + attribute (`change_slug`). This
  decides operation types, event names, functions and button labels alike - a
  name needing an exception is usually the wrong name.
- Identifiers and prose are separate vocabularies. Never build user-visible text
  by reformatting an identifier; map them to labels explicitly.
- **`box` is the web package's word** - the record Composery Cloud keeps for one
  running instance. Correct in `packages/web/**`, `docs/developing/web/**`, and
  the identifiers those own. Everywhere else say "Composery", "your Composery",
  or "your instance"; if you mean the server, say server. No third word.

## Prose

Reader-facing sentences (docs, UI, errors, CLI output, template READMEs, commit
and PR text) follow **Simplified Technical English (ASD-STE100)** as far as it fits: one word per meaning per
part of speech, plainest verb, active voice, simple tenses, one instruction per
sentence, condition first, articles kept, noun stacks of three at most, ~20
words per instruction. It is one-name-per-concept applied to sentences.

Internal prose that carries an argument - this file, test headers, comments
explaining why - keeps the vocabulary and drops the length limit. STE is a
default, not a gate: technical names, upstream spellings, quoted strings and
legal copy beat it. Deviate deliberately; `whitelist.jsonc` is the only check
and it merely lists every word, so a new word is a unit somebody must accept.

**Docs describe the system, never one account's state.** A doc must be
executable from nothing by someone with no access to the deployment: say what to
configure and how to know it worked. No values read out of a live console, no
"you will see three records", no step marked skippable because of how one
account looks today, no plan or tier assumed. Write conditional steps as
conditions ("if the zone arrived with the registrar's mail records, delete
them"). What the repository fixes - providers, variable names, paths, record
shapes - is stated flatly. Test: would it still be correct for a fork, or for
this deployment rebuilt tomorrow?

## Trust and reporting

The container is not a boundary against its user: privileged, root-capable, and
cloud owners control the host too - the Hetzner firewall is the real boundary
(`docs/developing/web/services/hetzner.md`). Both cloud containers now run on the
host's network stack, so a process an owner starts binds the machine's real
interface: that firewall is what decides whether anyone reaches it, and it is the
only thing that does. A deployment that widens it to sell ordinary server ports
moves the boundary onto each box's own firewall, which its owner can turn off -
so widening it is a change of posture to make deliberately, never a convenience.
An owner setting any `COMPOSERY_*` variable on their instance is a supported
surface; every env-driven feature must behave correctly when they do.

Never gate on `COMPOSERY_CLOUD_BOX_ID` to withhold a capability an owner could
take anyway. Do branch on it where the same action carries a different
consequence, so warnings stay true rather than merely cautious. Holding the
password never requires a website account - proving the current password is
enough anywhere; the account recovers a password you cannot produce.

New or changed env-driven IDE setting: update `docs/configuration.md`, then
decide whether an owner may set it via `convex/boxes/configuration.ts`. Offered
there - give enum values explicit labels, keep the wiring test green. Not
offered - record the managed or infrastructure reason beside the allowlist.

## Correctness

- Check claims against the artifact, not the source you assume produces it. A
  grep that misses one spelling is not proof of absence.
- **A check that cannot fail is worse than no check.** Break what a new test or
  guard protects and watch it fail before trusting it. Substring assertions are
  the usual culprit (`HASHED_PASSWORD` matches inside
  `COMPOSERY_HASHED_PASSWORD`).
- **Silent success is worse than a crash.** A variable nothing reads, a repair
  job checking the wrong name, a gate no sweep reaches - each looks healthy
  exactly as long as nobody checks. Make the inert path say so.
- Where a wrong value would remove a protection, fail towards keeping it: enable
  on explicit `1`/`true`, treat everything else - typos included - as off.
- Prefer one absolute rule to a rule plus a remembered exception.
- **Fix the class, not the instance.** Best: design it out (one source of truth,
  a derived value, an unrepresentable state). Next: a test catching the next
  instance. Worst: hand-patching the one you saw.
- Persistence cost is bounded by construction. Never add an exclusion to fix a
  performance problem - if cost scales with a workload's shape, that is the bug.

## Tests

Full doctrine: `docs/developing/testing.md`; every rule there names its enforcer
(`tests/invariants/tests.test.ts`), and a rule with no enforcer is deleted.

- `*.test.ts` lives under a `tests/` directory, never beside its subject. Rust
  meets the same rule with `#[cfg(test)]`, so its unit tests stay inline and
  `<crate>/tests/` holds the public-surface ones.
- The owning `tests/` directory belongs to the package the test constrains; what
  constrains none, or the agreement between two, lives in the root. Inside, the
  first subdirectory is the kind, the rest mirrors the source.
- **Three kinds, by what a test may touch.** `behavior/` runs the real module.
  `invariants/` reads the checkout and asserts a fact about it - last rung of the
  duplication ladder, so its header says why that duplication cannot be removed.
  `system/` needs a built artifact and alone may sleep or retry.
- `expect(source).toContain(...)` over code that could have run is the one shape
  that cannot fail for the right reason. Its helpers are confined to
  `invariants/`; everything else loads the module.
- A patch is a call site: logic lives in an overlay module the patch calls. Code
  inside a diff is reachable only by evaluating its added lines, which no
  coverage tool instruments.
- `test(`, never `it(`. The name completes a present-indicative sentence;
  `should` is filler. No `.only`, `.skip`, `.todo`.

Coverage only finds code nothing touches - no percentage target, no threshold.
`check:coverage` gates added lines; `check:mutants` says whether touching them
meant anything.

**A surviving mutant is killed or annotated with its reason - but read it
first.** Some cannot be killed by any test, and chasing those is how a suite
acquires tests written to move a number:

- Module-scope mutants (lookup maps, `internalMutation({...})` arguments) are
  evaluated once per worker and never re-evaluated, so the flip never takes
  effect. They report `coveredBy: 1` and survive under every `coverageAnalysis`.
  Apply the edit by hand: if tests fail, the report is wrong.
- The harness cannot see some real work - `.order("desc")` (convex-test sorts
  descending for anything but `"asc"`), or anything read only inside a workflow
  body. Recorded in `packages/web/tests/support/convex.ts`.
- Some guards are unreachable by construction and kept anyway, because the
  alternative is a silent wrong answer once what makes them unreachable moves.

Silence one line at a time: `// Stryker disable next-line <mutators>: <why>`.
The block form also silences mutants tests were killing, showing only a higher
ignored count. The directive must be the **last** comment line and must precede
a **statement** - inside a method chain it is ignored. Confirm `Ignored` moved.

## IDE fork

`packages/ide/` is a hard fork of code-server (submodule `packages/ide/upstream`).
**Split rule:** files that do not exist upstream live in `overlay/`; every change
to an upstream file is a patch in `patches/` - one concern per patch (a hunk
belongs in the patch whose name describes it; one patch may span `src/` and
`lib/vscode/*` when they are one concern), quilt fuzz=0 so upstream bumps fail
loudly. Never keep a modified copy of an upstream
file in the overlay.

- **An overlay path is its destination path.** `overlay/` mirrors the tree the
  build assembles - no timing, phase or second location to pick. When upstream's
  release step would not carry a file we add, patch the enumeration
  (`release-contents.diff`), never copy after the build. No test can enforce
  this: a wrong-but-plausible path simply never reaches the output.
- **`rebrand.mjs` owns every rename.** It runs on the assembled tree after quilt
  and overlay, before the upstream build. No patch renames an upstream
  identifier, string or variable; a hunk that would only rename belongs there.
  Patches anchor on upstream spelling, so `CS_DISABLE_FILE_UPLOADS` ships as
  `COMPOSERY_DISABLE_FILE_UPLOADS`. Absolute - any split leaves a name's home
  unknowable. Variables Composery introduces outright are written where read.
- Repo packages stay domain nouns (`ide`, `web`, `shared`, `cli`). Shipped
  surfaces are Composery: binary, path, product metadata, settings, cookie and
  socket names and product-specific env vars take `COMPOSERY_`. `PORT` stays
  generic. `docs/configuration.md` is the canonical variable list.
- Keep `code-server` only for upstream provenance and patch coordinates.
- No hybrid names like `composery-code-server`. A visible service is named for
  what it runs (`ide`, `persistence`, `caddy`, `cron`), identical across both
  init systems, so one runbook line covers `supervisorctl restart ide` and
  `systemctl restart ide`. There is no `composery` service.
- The `composery` prefix is namespacing, not decoration: only for identifiers
  injected into a shared upstream namespace (CSS classes, custom properties, DOM
  attributes, command/setting/extension IDs). Never on things we own outright.

@package.json

<!-- tree:start -->

> Live-updated by `scripts/tree.mjs` when `pnpm dev` or `pnpm dev:tree` is running. Manually update with `pnpm fix:tree`.

```text
.agents/
  skills/
    android-live-test/
      scripts/
        android.mjs
      EMULATOR-BROWSER.md
      SKILL.md
    claudes/
      SKILL.md
    green/
      SKILL.md
    nugget/
      SKILL.md
    refactor/
      SKILL.md
    senior-buzzwords/
      SKILL.md
    simplify-implementation.md
.claude/
  skills -> .agents/skills/
.github/
  ISSUE_TEMPLATE/
    bug.yaml
    config.yaml
  workflows/
    ci.yaml
    cla.yaml
    mutants.yaml
    release.yaml
    smoke-nightly.yaml
    smoke.yaml
    templates.yaml
  CLA.md
  IMAGE_RELEASE.md
  PULL_REQUEST_TEMPLATE.md
.opencode/
  .gitignore
.vscode/
  extensions.json
  launch.json
  settings.json
docs/
  developing/
    services/
      github.md
      index.md
      meta.json
    web/
      services/
        clerk.md
        cloudflare.md
        convex.md
        hetzner.md
        index.md
        meta.json
        polar.md
        resend.md
        vercel.md
      index.md
      maintenance.md
      meta.json
      operations.md
    ide.md
    index.md
    meta.json
    repository.md
    testing.md
  self-hosting/
    digitalocean.md
    disk-space.md
    fly.md
    index.md
    koyeb.md
    kubernetes.md
    meta.json
    other-platforms.md
    railway.md
    render.md
    vps.md
  ai-agents.md
  api.mdx
  configuration.md
  index.md
  meta.json
  openapi.yaml
  persistence.md
  ssh.md
packages/
  cli/
    crates/
      composery/
        src/
          commands/
            api.rs
            mod.rs
            persistence.rs
            ssh.rs
          certificates.rs
          cli.rs
          enrollments.rs
          keystore.rs
          lib.rs
          main.rs
          output.rs
        tests/
          cli.rs
        Cargo.toml
      persistence/
        src/
          apply.rs
          audit.rs
          baseline.rs
          boot.rs
          capabilities.rs
          config.rs
          control.rs
          daemon.rs
          dirty.rs
          doctor.rs
          engine.rs
          internal.rs
          layout.rs
          lib.rs
          lifecycle.rs
          metadata.rs
          overlay.rs
          paths.rs
          prune.rs
          public.rs
          readiness.rs
          rootfs.rs
          status.rs
          update.rs
          watch.rs
        tests/
          roundtrip.rs
        Cargo.toml
    Cargo.lock
    Cargo.toml
  ide/
    overlay/
      lib/
        vscode/
          extensions/
            composery-agents/
              extension.js
              package.json
              README.md
            composery-api/
              extension.js
              package.json
            composery-qr/
              extension.js
              package.json
              qrcode-generator.js
            composery-shortcuts/
              extension.js
              package.json
            composery-ssh/
              extension.js
              package.json
              prompt.js
              README.md
            composery-themes/
              themes/
                composery-dark.json
                composery-light.json
              package.json
              README.md
            composery-updates/
              extension.js
              package.json
          src/
            vs/
              base/
                browser/
                  imeEnter.ts
                  softKeyboard.ts
                  stickyModifiers.ts
                  touchGate.ts
                  touchSelectionHandles.ts
              code/
                browser/
                  workbench/
                    media/
                      fonts.css
                      geist-mono.woff2
                      inter.woff2
                      narrow.css
                      touch.css
                    shell.ts
              editor/
                browser/
                  controller/
                    touchPress.ts
                    touchSelection.ts
              platform/
                terminal/
                  common/
                    terminalDataFlowControl.ts
                  node/
                    terminalClients.ts
                    terminalLayoutMerge.ts
              server/
                node/
                  terminalClientState.ts
                  terminalStartState.ts
              workbench/
                browser/
                  media/
                    keybar.css
                  keybar.ts
                  narrowActivityBar.ts
                  narrowGate.ts
                  staleWebviewWorkers.ts
                contrib/
                  terminal/
                    browser/
                      shortcuts.contribution.ts
                      touchKeyboard.ts
                      xtermCell.ts
                      xtermResize.ts
                    common/
                      remote/
                        terminalWorkspaceId.ts
                  terminalContrib/
                    touchSelection/
                      browser/
                        terminal.touchSelection.contribution.ts
                  url/
                    browser/
                      loopbackCallback.ts
      src/
        browser/
          media/
            agents/
              claude-code.svg
              codex.svg
              hermes.svg
              NOTICE
              opencode.svg
              pi.svg
            composery-logo.svg
            favicon-dark.svg
            favicon-light.svg
            favicon.ico
            favicon.svg
            inter.woff2
            pwa-icon-192.png
            pwa-icon-512.png
            pwa-icon-maskable-192.png
            pwa-icon-maskable-512.png
          pages/
            auth.css
            auth.html
            auth.js
            brand.css
            change-password-fields.html
            cloud-error-fields.html
            error.html
            favicon.js
            global.css
            login-fields.html
            password-check.js
            register-fields.html
        node/
          persistence/
            readiness.ts
          routes/
            api/
              auth.ts
              config.ts
              constants.ts
              index.ts
              keystore.ts
              ratelimit.ts
              terminals.ts
            authErrors.ts
            authPage.ts
            changePassword.ts
            cloudAuth.ts
            loginRateLimit.ts
            passwordConfig.ts
            pwned.ts
            register.ts
            ssh.ts
          ssh/
            certificates.ts
            config.ts
          cloud.ts
          envFlag.ts
          session.ts
          volume.ts
    patches/
      api.diff
      auth.diff
      bfcache-reload.diff
      brand.diff
      clipboard-bridges.diff
      custom-editors.diff
      defaults.diff
      dependency-pins.diff
      editcontext-android.diff
      env-config.diff
      local-media-preview.diff
      loopback-callback.diff
      narrow.diff
      node-engine.diff
      proxy-root.diff
      qr-action.diff
      readiness.diff
      release-contents.diff
      request-host-trust.diff
      series
      sessions.diff
      shell-entry.diff
      shortcuts-bridge.diff
      ssh-menu.diff
      static-stamp.diff
      terminal-clients.diff
      terminal-sharing.diff
      touch.diff
      updates.diff
      vscode-duplicate-mount.diff
      webkit-paste.diff
      workbench-page.diff
      xterm-resize-scroll.diff
    scripts/
      build.sh
      rebrand.mjs
      types.mjs
    tests/
      behavior/
        lib/
          vscode/
            extensions/
              composery-agents/
                extension.test.ts
              composery-api/
                extension.test.ts
              composery-qr/
                extension.test.ts
              composery-shortcuts/
                extension.test.ts
              composery-ssh/
                extension.test.ts
              composery-updates/
                extension.test.ts
            src/
              vs/
                base/
                  browser/
                    softKeyboard.test.ts
                code/
                  browser/
                    workbench/
                      shell.test.ts
                editor/
                  browser/
                    controller/
                      touchPress.test.ts
                      touchSelection.test.ts
                platform/
                  terminal/
                    node/
                      terminalClients.test.ts
                      terminalLayoutMerge.test.ts
                server/
                  node/
                    terminalClientState.test.ts
                    terminalStartState.test.ts
                workbench/
                  browser/
                    staleWebviewWorkers.test.ts
                  contrib/
                    terminal/
                      browser/
                        touchKeyboard.test.ts
                        xtermResize.test.ts
                      common/
                        remote/
                          terminalWorkspaceId.test.ts
                    url/
                      browser/
                        loopbackCallback.test.ts
        scripts/
          rebrand.test.ts
        src/
          node/
            persistence/
              readiness.test.ts
            routes/
              api/
                auth.test.ts
                config.test.ts
                keystore.test.ts
                ratelimit.test.ts
                terminals.test.ts
              authErrors.test.ts
              authPage.test.ts
              changePassword.test.ts
              cloudAuth.test.ts
              loginRateLimit.test.ts
              passwordConfig.test.ts
              pwned.test.ts
              register.test.ts
            ssh/
              certificates.test.ts
            cloud.test.ts
            envFlag.test.ts
        session.test.ts
      invariants/
        auth-error-codes.test.ts
        auth-routes.test.ts
        coverage-exclusions.test.ts
        env-flags.test.ts
        patch-call-sites.test.ts
        patches.test.ts
        path-prefix.test.ts
        terminal-layout-types.test.ts
      support/
        overlay.ts
        patch.ts
    upstream/ (submodule)
    package.json
  shared/
    scripts/
      colors/
        index.html
        server.mjs
      icons.mjs
      logo.mjs
      sync.mjs
      theme.mjs
    tests/
      behavior/
        scripts/
          icons.test.ts
          logo.test.ts
          sync.test.ts
          theme.test.ts
        index.test.ts
        ssh.test.ts
      invariants/
        scripts/
          colors.test.ts
    index.ts
    package.json
    shiki.ts
    ssh.ts
    theme.json
    theme.ts
  web/
    app/
      (site)/
        _components/
          count-banner.tsx
          themed-shot.tsx
        boxes/
          _components/
            box-list.tsx
            checkout-redirect.tsx
            row-menu.tsx
          [id]/
            _components/
              box-actions.tsx
              box-detail.tsx
            configuration/
              _components/
                box-configuration.tsx
                config-field.tsx
              page.tsx
            page.tsx
          error.tsx
          page.tsx
        brand/
          _components/
            brand-kit.tsx
          page.tsx
        console/
          _components/
            alert-delivery.tsx
            capacity.tsx
            checkout-limit.tsx
            failures.tsx
            grant-box.tsx
            home.tsx
            metrics.tsx
            settings-card.tsx
            snapshot-policy.tsx
            stats.tsx
            thresholds.tsx
          boxes/
            [id]/
              _components/
                actions.tsx
                detail.tsx
                links.tsx
                snapshots.tsx
                suspend-dialog.tsx
              page.tsx
          page.tsx
        cookies/
          page.tsx
        licenses/
          page.tsx
        pricing/
          _components/
            fading-text.tsx
            faq.tsx
            pricing.tsx
            slug-dialog.tsx
          page.tsx
        privacy/
          page.tsx
        sign-in/
          [[...sign-in]]/
            page.tsx
        terms/
          page.tsx
        error.tsx
        layout.tsx
        not-found.tsx
        page.tsx
      api/
        cloud/
          auth/
            exchange/
              route.ts
            password/
              route.ts
          runtime/
            route.ts
        search/
          route.ts
      boxes/
        authorize/
          route.ts
      docs/
        [[...slug]]/
          page.tsx
        layout.tsx
      fonts/
        inter-latin-wght-normal.woff2
      llms-full.txt/
        route.ts
      llms.mdx/
        docs/
          [[...slug]]/
            route.ts
      llms.txt/
        route.ts
      og/
        docs/
          [...slug]/
            route.tsx
      apple-icon.png
      brand.css
      favicon.ico
      fonts.ts
      fumadocs.css
      global-error.tsx
      globals.css
      icon.svg
      layout.tsx
      providers.tsx
      robots.ts
      sitemap.ts
    components/
      base/
        badge.tsx
        button.tsx
        card.tsx
        chart.tsx
        dialog.tsx
        dropdown-menu.tsx
        input.tsx
        label.tsx
        select.tsx
        separator.tsx
        sonner.tsx
        table.tsx
        textarea.tsx
        tooltip.tsx
      box/
        actions-bar.tsx
        actions-menu.tsx
        agent-stack.tsx
        change-slug-dialog.tsx
        chart-card.tsx
        flags-table.tsx
        metrics-chart.tsx
        monitor-card.tsx
        operation-dialog.tsx
        qr-dialog.tsx
        repair-dialog.tsx
        reset-dialog.tsx
        running-indicator.tsx
        snapshots-dialog.tsx
        ssh-dialog.tsx
        status-action.tsx
        status-button.tsx
        status-text.tsx
        tone-icon.tsx
        update-dialog.tsx
        usage-card.tsx
      docs/
        mdx.tsx
        narrow-header.tsx
        openapi-operation.tsx
        openapi-page.tsx
        theme-toggle.tsx
      icons/
        arrow-right.tsx
        arrow-up-right.tsx
        book-open.tsx
        check.tsx
        claude-logo.tsx
        construction.tsx
        convex.tsx
        copy.tsx
        create.tsx
        credit-card.tsx
        delete.tsx
        download.tsx
        github-logo.tsx
        hetzner.tsx
        layout-grid.tsx
        linkedin-logo.tsx
        lock.tsx
        login.tsx
        openai-logo.tsx
        pen-tool.tsx
        play.tsx
        plug-zap.tsx
        plus.tsx
        polar.tsx
        rotate-cw.tsx
        scan-text.tsx
        square-pen.tsx
        sun-moon.tsx
        vercel.tsx
        wallet.tsx
        washing-machine.tsx
        wrench.tsx
        x-logo.tsx
        x.tsx
      animated-icon.tsx
      brand-icon.tsx
      confirm-dialog.tsx
      copy-email.tsx
      copy-link-button.tsx
      dismiss-button.tsx
      error-page.tsx
      footer.tsx
      header.tsx
      legal-page.tsx
      logo.tsx
      open-in.tsx
      page-template.tsx
      sort-header.tsx
      theme-provider.tsx
      theme-toggle.tsx
    convex/
      _generated/
        api.d.ts
        api.js
        dataModel.d.ts
        server.d.ts
        server.js
      account/
        deletion.ts
        deletionLogic.ts
      billing/
        polar.ts
        reconciliation.ts
        webhooks.ts
      boxes/
        infra/
          artifacts.ts
          cloudflareContracts.ts
          cloudflareDns.ts
          hetznerContracts.ts
          hetznerVps.ts
          host.ts
          hostCredentials.ts
          hostScripts.ts
          hostTransport.ts
          image.ts
          providerResponse.ts
          registry.ts
          registryContracts.ts
        operation/
          endpoint.ts
          event.ts
          record.ts
          start.ts
          sweep.ts
        workflows/
          boxWorkflow.ts
          changeBoxConfig.ts
          changeBoxPassword.ts
          changeBoxSlug.ts
          createBox.ts
          deleteBox.ts
          repairBox.ts
          resetBox.ts
          runtimeLifecycle.ts
          snapshotWorkflows.ts
          startBox.ts
          stopBox.ts
          suspendBox.ts
          unsuspendBox.ts
          updateBox.ts
        autoRepair.ts
        capacity.ts
        cleanup.ts
        configuration.ts
        counts.ts
        health.ts
        logs.ts
        metrics.ts
        metricsPoll.ts
        queries.ts
        reconcile.ts
        retention.ts
        slugAvailability.ts
        snapshotPolicy.ts
        snapshots.ts
        usage.ts
        version.ts
        views.ts
      checkout/
        checkoutConversion.ts
        checkoutIntents.ts
      instance/
        auth.ts
        release.ts
      model/
        box/
          auth.ts
          billing.ts
          capacity.ts
          certificate.ts
          domain.ts
          metric.ts
          operation.ts
          path.ts
          plan.ts
          recovery.ts
          slug.ts
          snapshot.ts
          ssh.ts
          status.ts
          usage.ts
        legal.ts
        links.ts
        settings.ts
      notice/
        account.ts
        legal.ts
        owner.ts
      owner/
        account.ts
        boxConfig.ts
        boxes.ts
        checkout.ts
      site/
        pricing.ts
        stats.ts
      staff/
        alerts.ts
        boxes.ts
        checkout.ts
        metrics.ts
        settings.ts
        stats.ts
        users.ts
      auth.config.ts
      convex.config.ts
      crons.ts
      email.ts
      env.ts
      http.ts
      schema.ts
      settings.ts
      time.ts
      tsconfig.json
      users.ts
    hooks/
      use-box-actions.ts
      use-busy-action.ts
      use-is-touch.ts
      use-reseed.ts
      use-setting-draft.ts
      use-table-sort.ts
    lib/
      box/
        billing.ts
        detail.ts
        repair.ts
        update.ts
        usage.ts
      docs/
        layout.tsx
        openapi.ts
        routes.ts
        source.ts
      auth-routing.ts
      brand-assets.ts
      browser-theme.ts
      clerk-appearance.ts
      clipboard.ts
      dashboards.ts
      datetime.ts
      env.ts
      error-message.ts
      highlight-logs.ts
      logo-data.ts
      nav-links.ts
      route-guards.ts
      utils.ts
    patches/
      fumadocs-mdx@15.2.1.patch
      fumadocs-ui@16.14.0.patch
    public/
      marketing/
        composery-editor-dark.png
        composery-editor-light.png
        composery-ide-dark.png
        composery-ide-light.png
        composery-mobile-dark.png
        composery-mobile-light.png
        composery-welcome-dark.png
        composery-welcome-light.png
      icon-dark.svg
      icon-light.svg
    scripts/
      screenshots/
        demo/
          prepare.sh
          reset.sh
          workspace.sh
        raw/
          dark/
            editor.png
            ide.png
            mobile-editor.png
            mobile-terminal.png
            mobile-welcome.png
            welcome.png
          light/
            editor.png
            ide.png
            mobile-editor.png
            mobile-terminal.png
            mobile-welcome.png
            welcome.png
        .gitignore
        capture-desktop.mjs
        capture-mobile.mjs
        finalize.mjs
        fonts.sh
        frame.mjs
        lib.mjs
        README.md
        run.sh
      env.d.mts
      env.mjs
    tests/
      behavior/
        app/
          (site)/
            pricing/
              _components/
                slug-dialog.test.ts
        components/
          box/
            actions-menu.test.ts
            change-slug-dialog.test.ts
            repair-dialog.test.ts
            reset-dialog.test.ts
            status-action.test.ts
          animated-icon.test.ts
          confirm-dialog.test.ts
          theme-provider.test.ts
        convex/
          account/
            deletion.test.ts
            deletionLogic.test.ts
          billing/
            polar.test.ts
            reconciliation.test.ts
            webhooks.test.ts
          boxes/
            infra/
              artifacts.test.ts
              cloudflareDns.test.ts
              hetznerVps.test.ts
              host.test.ts
              hostActions.test.ts
              hostCredentials.test.ts
              hostScripts.test.ts
              hostTransport.test.ts
              image.test.ts
              providerRequests.test.ts
              providerResponse.test.ts
            operation/
              record.test.ts
              start.test.ts
              sweep.test.ts
            workflows/
              boxWorkflow.test.ts
            autoRepair.test.ts
            capacity.test.ts
            capacityAlerts.test.ts
            cleanup.test.ts
            configuration.test.ts
            counts.test.ts
            logs.test.ts
            metrics.test.ts
            metricsPoll.test.ts
            purgeBox.test.ts
            queries.test.ts
            reconcile.test.ts
            recovery.test.ts
            retention.test.ts
            slugAvailability.test.ts
            snapshotPolicy.test.ts
            snapshots.test.ts
            usage.test.ts
            usageSweep.test.ts
            version.test.ts
            versionFloor.test.ts
            views.test.ts
          checkout/
            checkoutConversion.test.ts
            checkoutIntents.test.ts
          instance/
            auth.test.ts
          model/
            box/
              auth.test.ts
              billing.test.ts
              certificate.test.ts
              metric.test.ts
              metricThresholds.test.ts
              operation.test.ts
              path.test.ts
              plan.test.ts
              slug.test.ts
              snapshot.test.ts
              usage.test.ts
          notice/
            account.test.ts
            legal.test.ts
            owner.test.ts
          owner/
            boxConfig.test.ts
            boxes.test.ts
            checkout.test.ts
          staff/
            alerts.test.ts
            boxes.test.ts
            checkout.test.ts
            metrics.test.ts
            settings.test.ts
            stats.test.ts
            users.test.ts
          crons.test.ts
          env.test.ts
          http.test.ts
          settings.test.ts
          users.test.ts
        hooks/
          use-box-actions.test.ts
          use-is-touch.test.ts
          use-setting-draft.test.ts
          use-table-sort.test.ts
        lib/
          box/
            billing.test.ts
            repair.test.ts
            update.test.ts
            usage.test.ts
          docs/
            openapi.test.ts
          auth-routing.test.ts
          brand-assets-download.test.ts
          brand-assets.test.ts
          browser-theme.test.ts
          clipboard.test.ts
          dashboards.test.ts
          datetime.test.ts
          error-message.test.ts
          highlight-logs.test.ts
          nav-links.test.ts
          route-guards.test.ts
        scripts/
          env.test.ts
        support/
          ssh.test.ts
      invariants/
        components/
          icons/
            registry.test.ts
        convex/
          alert-remedies.test.ts
          audience-directories.test.ts
          box-inserts.test.ts
          browser-imports.test.ts
          components.test.ts
          envExample.test.ts
          missing-box-guards.test.ts
          optional-range-bounds.test.ts
          owner-authorization.test.ts
          schema-indexes.test.ts
          staff-authorization.test.ts
        legal/
          notices.test.ts
          processors.test.ts
        lib/
          table-columns.test.ts
        next-env-example.test.ts
      support/
        convex.ts
        ssh.ts
        ui.tsx
    .env.example.convex.dev
    .env.example.convex.prod
    .env.example.next.dev
    .env.example.next.prod
    .gitignore
    AGENTS.md
    CLAUDE.md -> packages/web/AGENTS.md
    components.json
    convex.json
    eslint.config.mjs
    next.config.ts
    package.json
    postcss.config.mjs
    proxy.ts
    source.config.ts
    tsconfig.json
    vercel.json
rootfs/
  etc/
    caddy/
      Caddyfile
    containerd/
      config.toml
    docker/
      daemon.json
    ssh/
      sshd_config.d/
        composery.conf
    sudoers.d/
      user
    supervisor/
      conf.d/
        composery.conf
      supervisord.conf
    systemd/
      system/
        containerd.service.d/
          composery.conf
        docker.service.d/
          composery.conf
        ssh.service.d/
          composery.conf
    xdg/
      mimeapps.list
    mailcap
  home/
    user/
      .config/
        user-dirs.dirs
      .local/
        share/
          composery/
            User/
              settings.json
      Desktop/
        .gitkeep
      Documents/
        .gitkeep
      Downloads/
        .gitkeep
      Music/
        .gitkeep
      Pictures/
        .gitkeep
      Public/
        .gitkeep
      Templates/
        .gitkeep
      Videos/
        .gitkeep
  opt/
    composery/
      init/
        overlay.sh
        supervisor.sh
        systemd.sh
      docker.sh
      entrypoint.sh
      ide.sh
      identity.sh
      remove-password.sh
      ssh.sh
      watchdog.sh
  usr/
    lib/
      systemd/
        system/
          caddy.service
          composery-watchdog.service
          ide.service
          persistence.service
    local/
      bin/
        wl-copy
        wl-paste
        xclip
        xsel
    share/
      applications/
        composery-text-editor.desktop
        composery-url-handler.desktop
scripts/
  cli.mjs
  coverage.mjs
  mutants.mjs
  setup.mjs
  tree.d.mts
  tree.mjs
  whitelist.d.mts
  whitelist.mjs
  write-formatted.mjs
templates/
  fly/
    fly.toml
    README.md
  kubernetes/
    composery.yaml
    ingress.yaml
    README.md
  railway/
    railway.json
    README.md
  render/
    README.md
    render.yaml
  supervisor-caddy-compose/
    Caddyfile
    compose.yaml
    composery.env
    README.md
  supervisor-compose/
    compose.yaml
    composery.env
    README.md
  systemd-caddy-compose/
    Caddyfile
    compose.yaml
    composery.env
    README.md
  systemd-compose/
    compose.yaml
    composery.env
    README.md
  user-data/
    README.md
    user-data.yaml
  README.md
tests/
  behavior/
    scripts/
      whitelist.test.ts
    mutants-script.test.ts
    setup.test.ts
    tree-agents-file.test.ts
    tree-script.test.ts
  fixtures/
    cert.pem
    key.pem
  invariants/
    api-openapi.test.ts
    brand-copy.test.ts
    brand-page.test.ts
    conventions.test.ts
    cross-platform.test.ts
    desktop-integration.test.ts
    docs-links.test.ts
    fixed-windows.test.ts
    keystore-contract.test.ts
    prettier-config.test.ts
    renovate.test.ts
    repair-workflow.test.ts
    runtime-init.test.ts
    stale-references.test.ts
    templates.test.ts
    tests.test.ts
    theme.test.ts
    toolchain-pins.test.ts
    tree-paths.test.ts
    workflows.test.ts
  support/
    repo.ts
  system/
    artifacts/
      run.mjs
    identity/
      Dockerfile
      run.sh
    overlay/
      Dockerfile
      run.sh
    providers/
      run.mjs
    registry/
      run.mjs
    templates/
      run.mjs
    smoke.mjs
.dockerignore
.editorconfig
.gitattributes
.gitignore
.gitmodules
.nvmrc
.prettierignore
.whitelistignore
AGENTS.md
CHANGELOG.md
CLAUDE.md -> AGENTS.md
compose.dev.yaml
Dockerfile
eslint.config.mjs
knip.jsonc
LICENSE
opencode.json
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
prettier.config.mjs
README.md
renovate.json
SECURITY.md
stryker.config.json
tsconfig.json
vitest.config.ts
vitest.mutation.config.ts
vitest.projects.ts
whitelist.jsonc
```

<!-- tree:finish -->
