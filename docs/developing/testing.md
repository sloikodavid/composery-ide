---
title: Testing
description: What each kind of test is for, where it lives, and what enforces the rule.
---

Every rule on this page names the check that enforces it. A rule with no enforcer
is not a rule - delete it from here rather than leave it as an honour system,
because nothing else in this repository is written by someone who will remember
it. The enforcers themselves live in `tests/invariants/tests.test.ts`.

## Where tests live

**Test code is structurally excluded from the shipped tree.** That is the whole
rule, and each language satisfies it its own way:

- TypeScript and JavaScript: a test is a `*.test.ts` file under a `tests/`
  directory. Never beside the module it exercises - the module graph cannot tell
  the two apart, and a colocated test ships with the source it tests.
- Rust: unit tests stay in `#[cfg(test)] mod tests` beside the code, because the
  attribute compiles them out of the binary and Rust's privacy model means an
  inline test can reach private items an external one cannot. Tests against a
  crate's public surface live in `<crate>/tests/`. This is Rust's own rule and it
  already satisfies the one above; it is not an exception to it.

The `tests/` directory that owns a test is the one belonging to the package whose
code it constrains. A test that constrains no single package - the repository as
an artifact, or the agreement between two packages - lives in the root `tests/`.

Inside a `tests/` directory the first subdirectory names the kind, and below that
the path mirrors the source it covers.

```text
packages/web/tests/behavior/convex/boxes/capacity.test.ts
packages/ide/tests/invariants/patches.test.ts
tests/system/smoke.mjs
```

> Enforced by `no test file sits outside a tests/ directory` and
> `every test file sits under a known kind`.

## The three kinds

A test's kind is decided by **what it is allowed to touch**, never by how it
feels. That is the only version of this question with an answer.

### `behavior/`

Imports the real module and runs it. May build a DOM, a stand-in host object, or
a fake clock. May not read the repository tree, shell out, or reach the network.

This is the only kind coverage and mutation testing count, and it should be the
bulk of the suite. If you cannot write one for a piece of code, that is a fact
about the code, not about the test.

### `invariants/`

Asserts a fact about the repository rather than the behaviour of code: that two
copies of a value agree, that a documented name matches real wiring, that a
generated file is current, that the patch stack applies.

These are the last rung of the duplication ladder in `CLAUDE.md` - remove the
second copy, else derive it from the first, else pin the pair with a test. Taking
the last rung makes the duplication permanent, so **an invariant test's header
states why the duplication cannot be removed or derived.** Without that sentence
this directory grows without anyone deciding it should.

Coverage ignores this directory entirely. A test that reads source text proves
the text exists; counting it as coverage would report the code as exercised when
nothing ran it.

> Enforced by `every invariants file explains its duplication`.

### `system/`

Runs a built artifact: the Docker image, privileged containers, a device. Not
vitest, not in-process, and the only kind allowed to sleep or retry. Slow, few,
and irreplaceable - `tests/system/overlay/run.sh` is the only proof that an
instance's filesystem survives being recreated, which is the product's core promise.

Every system harness is reachable from a workflow. One that is not is invisible,
and an invisible test is worse than a missing one because its presence reads as
coverage.

> Enforced by `every system harness is wired to a workflow`.

## Documentation

A doc test exists where a doc makes a **checkable claim** - a command, a variable
name, a schema, a path, a compose file - and never for prose. Testing English
only makes the docs expensive to edit.

They are not a fourth kind. "The doc agrees with the code" is an `invariants/`
test (`docs-links`, `envExample`, `api-openapi` already are). "The doc's commands
actually work" is `system/`. Rust examples are the exception that proves the
rule: ``````` blocks inside `///` comments are compiled and run by `cargo test`, so
they live beside the code like every other Rust test and cost nothing to wire.

Prefer a doctest to a prose example wherever the crate's public surface is
involved. An example that cannot compile is the one kind of documentation that
tells you it has rotted.

## Naming

A test file is named for what it constrains, and its path already says which
package and kind, so the name repeats neither.

A `describe` names the subject. A `test` completes a sentence about that subject
in the present indicative - what the code _does_, not what it _should_ do.
`should` is filler that survives from a decade of BDD tooling and adds nothing:

```ts
test("publishes the keyboard-open verdict from a viewport-height baseline");
test("rejects a token whose signature was minted with a rotated secret");
```

`it(` is banned outright - one spelling per concept, and `test(` is the plainer
one.

> Enforced by `test names are sentences, not shoulds` and `no it( aliases`.

## Determinism

- **No `.only`, `.skip`, or `.todo` in the tree.** A skipped test is a deleted
  test that still reports as present. Delete it or fix it.
- **Order independence.** The suite runs shuffled with a reported seed. A test
  that depends on another having run is broken today and will surface as a
  mystery in six months.
- **The clock is injected or faked.** Retention windows, `purge_at`, session
  lifetimes and snapshot policy are all time-dependent; a behaviour test reading
  `Date.now()` is a test that fails on a date nobody chose.
- **No `retry` and no `sleep` outside `system/`.** Real containers legitimately
  need both. A behaviour test that needs either is not flaky, it is wrong.

> Enforced by `no focused or skipped tests`, `behaviour tests do not sleep or
retry`, and `behaviour tests do not read the wall clock`.

## Source-text assertions

`expect(source).toContain("...")` against code that could have been executed is
the one shape that cannot fail for the right reason. It passes if a string is
present, so changing the code and updating the string is a green diff that proves
nothing - and it looks like diligence while doing it.

Rather than try to recognise the assertion, the tooling that makes it possible is
confined: **the patch-extraction helpers live in `packages/ide/tests/support/`
and may only be imported from an `invariants/` directory.** Everything else has
to run the code.

The IDE's behaviour tests that still read a patch are pinned in a list that may
only shrink. See below.

> Enforced by `patch helpers stay inside invariants` and `the patch-reading
allowlist only shrinks`.

## The IDE: patches are call sites

`packages/ide/patches/*.diff` exists so upstream bumps fail loudly at fuzz=0. It
was never meant to decide what is testable, but it does: logic written inside a
diff can only be reached by extracting its added lines and evaluating them, which
no coverage tool can instrument and which biases every assertion towards grep.

So: **a patch is a call site. Logic lives in an overlay module the patch calls.**

The two goals agree rather than compete - a patch with its logic extracted has
fewer context lines and survives more upstream bumps. `terminalDataFlowControl.ts`,
`touchSelectionHandles.ts`, `narrowGate.ts` and `keybar.ts` already work this way
and have the healthiest tests in the repository.

The target is not zero logic in patches; CSS-only, wiring-only and pin-only
patches have nothing to move. The target is **no tested logic in patches**.

Mechanically: a patch may not introduce a top-level declaration. That is blunt on
purpose - it says nothing about logic inside an upstream class's methods, which is
most of what the stack does and is genuinely call-site work, and it cannot be
satisfied by writing the same function inside a method instead. Declarations that
cannot be modules are allowed one at a time, each carrying the reason, in a list
that may only shrink.

> Enforced by `the patch stack introduces no top-level declaration of its own`,
> `every allowance is still needed` and `the sweep can see the declarations it
allows`.

Until the migration finishes, `packages/ide/tests/behavior/` files that still
extract from a diff are listed in `PATCH_READING_TESTS` in the enforcer suite.
That list may only shrink. Adding to it fails the build.

## Coverage and mutation

**Coverage's only honest job is finding code nothing touches.** A percentage
target is the one number that can be hit while making the suite worse - execute
the line, assert nothing - so there is no percentage target here. Instead:

- Changed lines must be covered. `pnpm check:coverage` fails on any line the diff
  adds that no behaviour test reaches. That is the whole gate.
- The global figure is reported and never thresholded. A number you must stay
  above fails for reasons unrelated to the change in front of you - delete a
  well-covered file and it drops - and it is satisfied by running a line without
  asserting on it. Read it to find what nothing touches; do not gate on it.

**Mutation testing is what says whether the touching meant anything.** It changes
the code - flips a comparison, drops a line - and reports which tests noticed. A
test that notices nothing is exposed regardless of who wrote it or how convincing
its header reads. Given that every line here is written by an agent, and the same
agent usually writes the test, this is the load-bearing check and not a nicety.

- `pnpm check:mutants` runs Stryker and `cargo-mutants` over the current diff. It
  gates pull requests.
- The nightly sweep runs both in full. Its floor (`break` in
  `stryker.config.json`) is raised by hand when the score rises and never
  lowered to make a red run green - a deliberate ratchet, not an automatic one.
- **A surviving mutant is triaged, never ignored**: killed by a test, or
  annotated as equivalent with the reason. An untriaged survivor list is a
  coverage percentage wearing a different hat.

### Survivors that are not gaps

Some mutants cannot be killed by any test, and treating the report as a to-do
list is how a suite acquires tests written to move a number rather than to state
a truth. Read the survivor before writing anything, and check `coveredBy` in the
JSON report:

- **Module-scope mutants cannot be flipped.** A lookup map, a `Record` of
  renames, the object passed to `internalMutation({...})` - anything evaluated
  when the module is first imported into a Vitest worker keeps the value it got
  then, because the module is not re-evaluated per mutant. Such a mutant reports
  `coveredBy: 1` (only the test that first imported the module) and survives
  under every `coverageAnalysis` setting. Applying the same edit by hand and
  running the suite is what tells you apart: if tests fail, the report is wrong
  and there is nothing to write.
- **The harness cannot see some real work.** `.order("desc")` is one:
  `convex-test` sorts descending for every value that is not exactly `"asc"`, so
  the literal is invisible. A workflow body is another - it cannot run here at
  all, so `workflowArgs` is unreadable. Both are recorded, with the rest of their
  kind, in `packages/web/tests/support/convex.ts`.
- **Some guards are unreachable by construction** and are kept anyway, because
  the alternative to the guard is a silent wrong answer if the thing that makes
  it unreachable ever moves. Annotate with what makes it unreachable today.

**Silence a mutant one line at a time.** `// Stryker disable next-line
<mutators>: <why>` only. The block form (`disable` … `restore`) silences
everything of those kinds in its range including mutants tests were killing, and
the only trace is a higher ignored count: one block pair around a short helper
took Ignored from 14 to 151 and Killed from 303 to 193. `tests/invariants/
tests.test.ts` fails on a block form and on a directive with no reason.

Two placement rules follow from how Stryker attaches a directive: it must be the
**last** comment line before the code, and it must precede a **statement** - one
inside a method chain (above `.order("desc")`) is silently ignored. Confirm the
`Ignored` count moved; a mutant you believe you annotated that still reads
`Survived` was never annotated.

## Commands

| Command                                  | What it does                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm check:test`                        | The whole suite, shuffled, with coverage. One vitest run; every project lives in `vitest.config.ts`. |
| `pnpm vitest run --project web:behavior` | One suite. Projects are named `<package>:<kind>`.                                                    |
| `pnpm check:coverage`                    | Fails on any line the current diff adds that no behaviour test reaches.                              |
| `pnpm check:mutants`                     | Stryker and `cargo-mutants` over the current diff. Nothing may survive.                              |
| `pnpm check:knip`                        | Unused files, exports and dependencies - the rot agents leave behind.                                |
| `pnpm system:smoke`                      | Boots the built image and exercises it.                                                              |
| `pnpm system:templates`                  | Validates every deployment manifest that has a published schema, plus Fly's strict validator.        |
| `pnpm system:providers`                  | Checks provider response decoders against the current Hetzner and Cloudflare OpenAPI specifications. |
| `pnpm system:registry`                   | Resolves a public multi-platform image through the real Registry V2 authentication and pull API.     |
| `pnpm system:artifacts`                  | Checks every rendered host script with Bash and the rendered Compose file with Docker Compose.       |
| `pnpm system:compose`                    | Builds the image and boots every copied Compose deployment recipe.                                   |
| `pnpm system:overlay`                    | Proves persistence survives a container being destroyed.                                             |

Every `system:` script is one harness under `tests/system/`, named for its
directory, so the list above and that directory hold the same names. None runs
from `pnpm check`: each needs the network, a built image, or Docker.

`check:coverage`, `check:mutants` and `check:knip` sit outside `check:portable`
and run from `pnpm check`: none has OS-specific behaviour to repeat on three
runners, and the first two need fetched history to find a base commit. They
refuse to run rather than report a pass over nothing, so a shallow clone fails
loudly instead of going quiet.

## Adding a test

1. Decide the kind from what it must touch. If it wants to touch the repository
   tree _and_ run code, it is two tests.
2. Put it under the owning package's `tests/<kind>/`, mirroring the source path.
3. Write a header saying what it constrains - and, in `invariants/`, why the
   duplication it pins cannot be removed or derived instead.
4. Break the thing it guards and watch it fail before you trust it.
