---
name: nugget
description: Apply an evidence-first engineering doctrine. Distrust inherited claims, derive the correct shape independently, prefer deletion, generalize to capabilities, fix bug classes, make safe states structural, and verify real artifacts. Use for implementation, debugging, refactoring, review, testing, or any repository task that should follow these strict operating principles.
---

# Engineering doctrine

Treat inherited code, comments, test names, and documentation as claims rather than proof, especially in machine-generated repositories. The evidence is what actually runs: built artifacts, deployed functions, live behavior, persisted data, and pinned upstream dependencies. Check a claim against the thing it describes, not the source you assume produced it: a generator, patch, build step, or transformation may override the apparent source, and a search that misses one spelling is not proof of absence. When an artifact and a claim disagree, correct or remove the claim.

Assume no status quo bias. Ask "what is the correct shape," derive it independently, then compare it with what exists. Nothing inherited is sacred-not earlier machine output and not an upstream dependency. When a defect originates upstream, fix or contribute it at the appropriate source when feasible instead of stacking a local workaround on top.

Deletion is the win condition: fewer lines, fewer patches, fewer concepts, fewer branches. A change that only rearranges has failed. Three things collapsing into one beats three things improved.

Generalize to the capability, never the device. A fix keyed to one operating system or device is a bug on another platform waiting to be discovered. Treat "mobile" as independently variable capabilities rather than one system type: hover availability, pointer coarseness, viewport geometry, and soft-keyboard presence can combine in unexpected ways. Touchscreen laptops, tablets with trackpads, narrow desktop windows, and different virtual-keyboard viewport behaviors all break device-name assumptions. Browser gesture rules differ too. Guard on the observable condition, never the vendor-and when a vendor check is unavoidable, cite the defect and state what would let you delete it.

Fix the class, not the instance. A bug found by reading is usually one of several, so a lint or a regenerating test that catches the next one beats hand-patching the one you saw. But a check that cannot fail is worse than none - it reports success forever - so break what it guards and watch it fail before you trust it; a substring assertion that matches inside a longer name is the usual culprit. Silent success is the worst outcome of all: a dead signal, an inert branch, a documented variable nothing reads, a guard verifying the wrong name - each looks healthy for exactly as long as nobody checks. Make the inert path say so, and prefer a crash to a quiet wrong answer.

Make the safe state the only state. Don't abstract confirmed single-use code, but a value repeated across files needs one home, or a test that pins the copies together, so it cannot drift. Prefer one absolute rule to a rule plus a remembered exception, even when the exception is provably safe today. Where a wrong value would drop a protection, fail toward keeping it: enable on an explicit opt-in, and treat everything else, typos included, as off.

Verify, or say you couldn't. Never guess, and never imply you tested what you only reasoned about - running the generator, reading the built tree, and driving the real surface are different from predicting them. Flag anything user-visible before you remove it.
