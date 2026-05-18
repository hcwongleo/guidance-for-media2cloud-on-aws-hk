# Tab-Stacking Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the webapp from rendering two top-level tabs stacked when the user clicks a second tab while the first is still loading.

**Architecture:** A single early-return at the top of `BaseTab.show()` reuses Bootstrap's existing `active` class on the nav-link `<a>` as the "am I still the target tab?" check. If a `show()` resumes after Bootstrap has already moved focus elsewhere, the gate skips the load-bearing `tab('show')` call and the stale render does nothing.

**Tech Stack:** Vanilla ES6 modules + jQuery 3.x + Bootstrap 4.x. No bundler — `npm run build` is a copy step.

**Spec:** `docs/superpowers/specs/2026-05-18-tab-stacking-bug-fix-design.md`

---

## File Structure

| File | Change |
| --- | --- |
| `source/webapp/src/lib/js/app/shared/baseTab.js` | **Modify** — add one early-return line at the top of the `show(hashtag)` method. |

No new files. No other modifications. No test framework wiring (user opted out of automated tests).

---

## Task 1: Pre-implementation audit

**Files:**
- Read: `source/webapp/src/lib/js/app/shared/baseTab.js:121-131`

The spec assumes `baseTab.js:128` is the only call site of `.tab('show')` in the webapp. Confirm that before changing anything — if a second call site exists, the fix is incomplete.

- [ ] **Step 1: Grep for `.tab('show')` in the webapp source**

Run:
```bash
grep -rn "\.tab('show')" source/webapp/src --include="*.js"
```

Expected output (single line):
```
source/webapp/src/lib/js/app/shared/baseTab.js:128:    this.tabContent.tab('show');
```

If any additional matches appear, **stop**, report them, and update the spec's risk section before proceeding. Each additional call site would also need to be gated.

- [ ] **Step 2: Confirm the current `show()` body matches the spec's pseudo-diff**

Read `source/webapp/src/lib/js/app/shared/baseTab.js:121-131`. The body should be:

```js
async show(hashtag) {
  this.initialized = true;

  this.tabLink
    .children('a')
    .addClass('show active');

  this.tabContent.tab('show');

  return this.tabContent;
}
```

If the current body has diverged (someone added more lines), confirm the new line still goes at the very top and proceed.

- [ ] **Step 3: Confirm baseline tab-stacking bug exists (optional but recommended)**

If you have a deployed dev environment for this branch, reproduce the bug *before* applying the fix so the post-fix verification has a real comparison. If no dev environment, skip — the spec's verification step 4 covers this with stash-based toggling.

Procedure (only if dev environment is available):
1. Open the webapp in Chrome.
2. DevTools → Network → throttling: Slow 3G.
3. Click Settings, then immediately click Collection.
4. Confirm both panes render visibly stacked (nav highlights one, but content shows both).
5. Take a screenshot for the record.

- [ ] **Step 4: Commit nothing — this task only audits**

No commit at this task boundary; the next task makes the actual change.

---

## Task 2: Apply the one-line gate

**Files:**
- Modify: `source/webapp/src/lib/js/app/shared/baseTab.js:121` (insert one line after the `async show(hashtag) {` opening brace)

- [ ] **Step 1: Add the gate line**

Use the Edit tool. In `source/webapp/src/lib/js/app/shared/baseTab.js`, replace:

```js
  async show(hashtag) {
    this.initialized = true;
```

with:

```js
  async show(hashtag) {
    if (this.initialized && !this.tabLink.children('a').hasClass('active')) {
      return;
    }
    this.initialized = true;
```

The block-style `if (...) { return; }` (rather than a one-liner) matches the file's existing brace style — see lines 50-52 and 110-112 of the same file.

- [ ] **Step 2: Diff sanity check**

Run:
```bash
git diff source/webapp/src/lib/js/app/shared/baseTab.js
```

Expected output (only addition, no other changes):
```diff
   async show(hashtag) {
+    if (this.initialized && !this.tabLink.children('a').hasClass('active')) {
+      return;
+    }
     this.initialized = true;
```

If anything else changed (whitespace, line endings, unrelated edits), revert with `git checkout source/webapp/src/lib/js/app/shared/baseTab.js` and redo the edit.

- [ ] **Step 3: Build to verify no syntax error**

Run:
```bash
cd source/webapp && npm run build
```

(`npm install` may run first if `node_modules` is missing.) Expected output ends with `build:copy` succeeding — the `cp -rv` will list every file copied. Errors during copy indicate a syntax issue (rare since this is just `cp`, not a JS parse). If errors appear, fix and re-run.

After the build, return to the worktree root:
```bash
cd ../..
```

- [ ] **Step 4: Commit**

Run:
```bash
git add source/webapp/src/lib/js/app/shared/baseTab.js
git commit -m "$(cat <<'EOF'
Fix tab-stacking when user switches tabs mid-load

When a tab's async show() resumes after the user has moved to a
different tab, BaseTab.show() used to re-assert its pane as active via
tab('show'), leaving both panes with .active.show. Add an early-return
that bails when Bootstrap has already removed the 'active' class from
this tab's nav-link.

Spec: docs/superpowers/specs/2026-05-18-tab-stacking-bug-fix-design.md
EOF
)"
```

---

## Task 3: Manual verification

**Files:** None modified. This task runs the verification matrix from the spec.

Pre-requisite: a way to run the webapp against the deployed M2C backend (or a fully mocked equivalent). Two paths:

- **Local static serve + deployed backend.** `cd source/webapp/dist && npx http-server -p 8080`, then open `http://localhost:8080` and sign in against the deployed Cognito.
- **Deploy to a dev S3 + CloudFront.** Use the existing CDK/CloudFormation stack with this branch checked out.

Use whichever you already have working for this repo. The verification scenarios are environment-agnostic.

- [ ] **Step 1: Open DevTools and throttle the network**

In Chrome → DevTools → Network → set throttling to **Slow 3G**. This makes tab loads visibly slow so the race window is wide enough to hit reliably.

- [ ] **Step 2: Verify the original bug is fixed (Settings ↔ Collection)**

Procedure:
1. Refresh the page; sign in if needed.
2. Click **Settings**.
3. Before Settings finishes loading, click **Collection**.
4. Wait for Collection to finish loading.

Expected: only Collection's content is visible. No stacking.

If both panes still appear stacked, the fix did not take effect — check that the build was redeployed/refreshed (browser cache may serve the old `baseTab.js`; hard-reload with Cmd-Shift-R / Ctrl-Shift-R).

- [ ] **Step 3: Repeat for every adjacent top-level pair**

Pairs to test (click first, then immediately click second):

1. Collection → Settings
2. Settings → Stats (if `HASSEARCHENGINE` is enabled in the deploy)
3. Stats → Upload
4. Upload → Face Collection
5. Face Collection → Settings
6. Settings → User Management (only visible to users with modify access)
7. Collection → Upload
8. Collection → Processing

For each pair: only the second-clicked tab's content should be visible.

- [ ] **Step 4: Re-entry regression check**

Procedure:
1. Click Collection → wait for full load.
2. Click Settings → wait for full load.
3. Click Collection again.

Expected: Collection re-renders correctly the second time. (This is the case where `initialized=true` and Bootstrap re-adds `active` on click — the gate must not block legitimate re-entry.)

- [ ] **Step 5: Slow-nav (no rapid switch) regression check**

Procedure:
1. Click Collection → wait for full load.
2. Inside Collection, click each sub-tab (Video / Photo / Document / Podcast / Search) one at a time, waiting for each to load.

Expected: each sub-tab loads and switches normally. Sub-tab navigation should be unchanged by this fix (the gate is on `BaseTab` so it applies to sub-tabs too, but slow-nav cases never trigger the bail because Bootstrap has had time to set `active` correctly).

- [ ] **Step 6: Hashtag deep-link regression check**

Procedure:
1. Reload the page directly at `#settings` (or `#settings/<sub-route>` if the deployment supports it). The URL hash drives `mainView._show()` at boot.

Expected: the deep-linked tab renders correctly. (At boot, `initialized=false`, so the gate short-circuits and lets the first render through.)

- [ ] **Step 7: Sub-tab regression check inside Collection**

Procedure:
1. Click Collection → wait until Video sub-tab content appears.
2. Click the Photo sub-tab → immediately click the Document sub-tab.

Expected: only Document's content is visible. (The gate applies to sub-tabs because they extend `BaseTab`; this is a free win, not in scope but worth verifying.)

If sub-tab stacking still occurs, that's a known limitation noted in the spec — file a follow-up but do **not** fail this task.

- [ ] **Step 8: Record verification results**

In the commit message of Task 4 (push), include a one-line summary of which scenarios were verified. Example: "Verified: pairs 1-8, re-entry, slow-nav, deep-link, sub-tab Photo→Document."

If any scenario failed, **stop** and treat the failure as a bug to investigate before proceeding. The fix is small enough that any failure points to a wrong assumption in the spec — re-read the design doc.

---

## Task 4: Push the branch

**Files:** None — git operations only.

- [ ] **Step 1: Confirm branch is clean and ahead of origin**

Run:
```bash
git status
git log origin/short-form-video..HEAD --oneline
```

Expected:
- `git status`: clean working tree.
- `git log`: at least the bug-fix commit from Task 2, plus any spec/plan commits.

- [ ] **Step 2: Push**

Run:
```bash
git push origin short-form-video
```

Expected: branch updated, no errors.

- [ ] **Step 3: Confirm in GitHub**

Open `https://github.com/hcwongleo/guidance-for-media2cloud-on-aws-hk/tree/short-form-video` and confirm the new commits are present.

---

## Task 5: Update memory and task list

- [ ] **Step 1: Mark all tasks complete**

Use `TaskUpdate` to mark every task in the active task list as `completed`.

- [ ] **Step 2: No memory updates needed**

This is a small bug fix with no surprising or non-obvious lessons that future conversations would benefit from. Skip the memory update unless something genuinely surprising came up during implementation (e.g. the audit found additional `.tab('show')` call sites — that would be worth a project memory).
