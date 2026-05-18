# Tab-Stacking Bug Fix — Design

**Date:** 2026-05-18
**Branch:** `short-form-video`
**Sub-project:** A (of 6 in the new-product roadmap)
**Status:** Implemented and verified live on dev environment.

## Problem

When the user clicks a top-level tab (e.g. Settings) and, before its content finishes loading, clicks a different tab (e.g. Upload), the screen renders both tabs' content stacked on top of each other.

## Root cause

`source/webapp/src/lib/js/app/shared/baseTab.js`:

- Each `BaseTab` binds its anchor to Bootstrap's `shown.bs.tab` event (line 45) and runs `await this.show()`.
- `BaseTab.show()` ends with `this.tabContent.tab('show')` (line 128 of the original file), which tells Bootstrap to mark *this* pane as `.active.show`.
- If the **subclass** `show()` is mid-`await` when the user clicks a different tab, Bootstrap correctly switches to the new pane. But when the in-flight `show()` later resolves and chains into `super.show()`, the `tab('show')` call **re-asserts the old pane as active** without deactivating the new one. Both panes end up with `.active.show` → stacking.

Subclass overrides (`uploadTab.js`, `mxAnalysisSettings.js` for SettingsTab, etc.) all follow the same pattern: heavy `await` inside the subclass, then `return super.show(hashtag)` at the end. Same race in every one of them.

## Approach (chosen): sibling-active gate at the top of `BaseTab.show()`

Bootstrap's tab plugin manages the `.active` class on every nav-link. When the user clicks a new tab, Bootstrap **adds** `.active` to the new tab's nav-link and **removes** it from the previously active sibling — before firing `shown.bs.tab` on the new one. We use that as the "has someone else taken over while I was awaiting?" signal.

Add an early-return at the top of `BaseTab.show()`:

```js
async show(hashtag) {
  const ourLink = this.tabLink.children('a');
  const siblingActive = this.tabLink.parent()
    .siblings()
    .children('.nav-link.active')
    .length > 0;
  if (siblingActive && !ourLink.hasClass('active')) {
    return;
  }
  this.initialized = true;
  this.tabLink.children('a').addClass('show active');
  this.tabContent.tab('show');
  return this.tabContent;
}
```

### How it covers every scenario

| Scenario | Sibling has `.active`? | Our nav-link has `.active`? | Behavior |
| --- | --- | --- | --- |
| Boot via `mainView._show()` (called once at app start, before any user interaction) | No (no tab is active yet) | No | Proceeds → first render |
| User clicks a tab; Bootstrap-driven `show()` runs | No (Bootstrap removed `.active` from the previous active sibling) | Yes (Bootstrap just set it) | Proceeds |
| **The bug:** subclass `show()` resumes a stale `await` after the user clicked away | Yes (the new tab is now active) | No (Bootstrap removed it) | **Bails** — `tab('show')` is not called → stale render is silently dropped → no stacking |
| User clicks A → B → A | When A's show runs the second time, Bootstrap has already activated A and deactivated B | Yes | Proceeds |

The boot path is correct because at app start, no nav-link has `.active` yet — so `siblingActive` is `false` and the gate proceeds. The check uses two pieces of information (sibling state + own state) instead of an `initialized` flag, which is what an earlier version of this fix used incorrectly (see "What we learned" below).

### Approaches considered and rejected

- **`AbortController` per fetch.** Cancels network too, but the webapp's API helpers don't currently accept a `signal` — bigger surgery for marginal benefit. Can layer in later.
- **Block tab clicks while loading.** Disabling nav until the current load finishes feels sluggish; user explicitly preferred immediate switching.
- **Render-epoch counter.** With single-file scope, the capture-then-check pattern is a no-op (no awaits inside `BaseTab.show()` itself). Only earns its keep with subclass cooperation, which is out of scope.
- **`isActive` boolean toggled by `shown.bs.tab` / `hide.bs.tab`.** Functionally equivalent to the sibling-active check but adds an extra field and an extra event binding — Bootstrap's `.active` class already encodes the same state, so the dedicated boolean is duplicative.

## Scope (chosen)

**Single file:** `source/webapp/src/lib/js/app/shared/baseTab.js`. Five lines added.

The base-class change is load-bearing — gating `tab('show')` is what stops Bootstrap from re-asserting the stale pane. Subclasses that also append DOM after a long `await` may briefly flush stale content into a hidden pane, but this only manifests as stale content the *next* time the tab is opened, not as visible stacking. Acceptable trade-off; revisit if a regression is reported.

Out of scope:

- Sub-tabs inside Collection (Video / Photo / Document / Podcast / Search).
- Analysis-component sub-views (`baseAnalysisTab.js`, `analysisComponent.js`, etc.).
- Bootstrap version upgrade.
- Test framework setup.

## Implementation

`source/webapp/src/lib/js/app/shared/baseTab.js`, `show(hashtag)`:

```diff
   async show(hashtag) {
+    const ourLink = this.tabLink.children('a');
+    const siblingActive = this.tabLink.parent()
+      .siblings()
+      .children('.nav-link.active')
+      .length > 0;
+    if (siblingActive && !ourLink.hasClass('active')) {
+      return;
+    }
     this.initialized = true;
     this.tabLink.children('a').addClass('show active');
     this.tabContent.tab('show');
     return this.tabContent;
   }
```

Nothing else changes in the file.

## Verification (manual, performed against deployed dev environment)

Verified on `https://d3tpjxm36qno39.cloudfront.net` with Chrome DevTools network throttled to Slow 3G. The CloudFront-served bundle was rebuilt via `node post-build.js rollup` and the integrity hash on `index.html`'s `<script src="./app.min.js">` was patched in place; CloudFront cache invalidated for `/app.min.js`, `/index.html`, `/`.

1. Settings → click Upload mid-load: only Upload renders. ✅
2. Other adjacent pairs: ✅
3. Re-entry (A → B → A): ✅
4. Slow nav, sub-tabs: ✅
5. Deep-link reload: ✅

## What we learned (correction)

An initial version of this fix used `if (this.initialized && !ourLink.hasClass('active')) return;`. The `initialized && ...` short-circuit was meant to allow boot, but it also disabled the gate on **every first-time stale render** — `initialized` is still `false` when the subclass resumes its `await` and chains into `super.show()` for the first time, so the short-circuit let `tab('show')` re-assert the stale pane. The bug reproduced even after the fix shipped.

The corrected fix replaces the `initialized` short-circuit with a check on the **sibling nav-links**: at boot, no sibling is active (so the gate is a no-op); at stale-resume time, Bootstrap has already moved `.active` to the new tab's nav-link (so the gate fires). This handles both first-time and re-entry cases without any new state.

Lesson: when a gate uses two conditions joined by `&&`, work through every state-pair (`initialized × hasClass`) before declaring victory. Boot and first-time-stale-render share the same `initialized=false` state — they cannot be distinguished by `initialized` alone.

## Risks

- **Other places that re-assert pane visibility.** Audited at implementation time: `.tab('show')` is called in two places in the webapp source — `baseTab.js:128` (the call this gate protects) and `mainView/upload/finalizeSlideComponent.js:791` (an internal upload-progress slide tab list, event-driven, not subject to this race). Re-audit if a future PR adds another call site.
- **Bootstrap class behavior assumption.** This fix relies on Bootstrap's tab plugin (a) adding `.active` to the newly clicked nav-link and (b) removing `.active` from the previously active sibling — both before firing `shown.bs.tab` on the new tab. Bootstrap 4 does this. A future Bootstrap upgrade should re-validate this assumption.
- **Stale content in hidden pane.** A subclass `show()` whose `await` resolves after the user has switched away will still append content to its (now hidden) `tabContent`. Next time that tab is opened, the user may briefly see old data flushed in. Not blocking — flagged for follow-up if observed.

## Out of scope / follow-ups

- Subclass `show()` updates (collectionTab, statsTab, uploadTab, userManagementTab, faceCollectionTab, processingTab, mxAnalysisSettings) to also bail post-await — adds belt-and-suspenders against stale-content.
- AbortController wiring through API helpers.
- Playwright e2e harness for regression coverage.
