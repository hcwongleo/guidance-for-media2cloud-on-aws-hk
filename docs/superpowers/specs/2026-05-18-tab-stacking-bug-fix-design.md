# Tab-Stacking Bug Fix — Design

**Date:** 2026-05-18
**Branch:** `short-form-video`
**Sub-project:** A (of 6 in the new-product roadmap)
**Status:** Design — awaiting user review

## Problem

When the user clicks a top-level tab (e.g. Settings) and, before its content finishes loading, clicks a different tab (e.g. Collection), the screen renders both tabs' content stacked on top of each other.

## Root cause

`source/webapp/src/lib/js/app/shared/baseTab.js`:

- Each `BaseTab` binds its anchor to Bootstrap's `shown.bs.tab` event (line 45) and runs `await this.show()`.
- `BaseTab.show()` ends with `this.tabContent.tab('show')` (line 128), which tells Bootstrap to mark *this* pane as `.active.show`.
- If `show()` is mid-`await` when the user clicks a different tab, Bootstrap correctly switches to the new pane. But when the in-flight `show()` later resolves and runs `tab('show')`, it **re-asserts the old pane as active** without deactivating the new one. Both panes end up with `.active.show` → stacking.

Subclass overrides (`collectionTab.js`, `statsTab.js`, etc.) follow the same pattern: they `await` heavy work and then call `super.show()`. Same race exists.

## Approach (chosen): one-line class-membership gate in `BaseTab.show()`

Bootstrap's tab plugin already manages the `active` class on the nav-link `<a>` — it sets the class on the newly clicked tab and clears it from the previously active one, before firing `shown.bs.tab`. We can use that as the "am I still the target tab?" check, free of charge.

Add a single early-return at the top of `BaseTab.show()`:

```js
if (this.initialized && !this.tabLink.children('a').hasClass('active')) return;
```

That's it. No new fields, no new event listeners.

### How it covers every scenario

| Scenario | `initialized` | `hasClass('active')` | Behavior |
| --- | --- | --- | --- |
| Boot via `mainView._show()` (the one direct programmatic call site, at app start) | `false` | n/a — short-circuit | proceeds → first render |
| User clicks a tab (Bootstrap-driven) | `true` or `false` | `true` (Bootstrap just set it) | proceeds |
| **The bug:** stale `show()` resumes after user switched to a different tab | `true` | `false` (Bootstrap removed it when the other tab was clicked) | bails — `tab('show')` is **not** called → no re-assertion → no stacking |
| Re-clicking A after going to B and back | `true` | `true` (Bootstrap re-set it on click) | proceeds |

The only programmatic invocation of a tab's `show()` outside Bootstrap's flow is `mainView.js:171` at app boot, when `initialized` is still `false` — so the gate skips and the first render happens normally.

### Approaches considered and rejected

- **`AbortController` per fetch.** Cancels network too, but the webapp's API helpers don't currently accept a `signal` — bigger surgery for marginal benefit. Can layer in later.
- **Block tab clicks while loading.** Disabling nav until the current load finishes feels sluggish; user explicitly preferred immediate switching.
- **Render-epoch counter.** With single-file scope, the capture-then-check pattern is a no-op (no awaits inside `BaseTab.show()` itself). Only earns its keep with subclass cooperation, which is out of scope.
- **`isActive` boolean toggled by `shown.bs.tab` / `hide.bs.tab`.** Functionally equivalent to the chosen approach but adds an extra field and an extra event binding for no gain — Bootstrap's `active` class already encodes the same state.

## Scope (chosen)

**Single file, single line:** `source/webapp/src/lib/js/app/shared/baseTab.js`.

The base-class change is load-bearing — gating `tab('show')` is what stops Bootstrap from re-asserting the stale pane. Subclasses that also append DOM after a long `await` may briefly flush stale content into a hidden pane, but this only manifests as stale content the *next* time the tab is opened, not as visible stacking. Acceptable trade-off; revisit if a regression is reported.

Out of scope:

- Sub-tabs inside Collection (Video / Photo / Document / Podcast / Search).
- Analysis-component sub-views (`baseAnalysisTab.js`, `analysisComponent.js`, etc.).
- Bootstrap version upgrade.
- Test framework setup.

## Implementation

### `source/webapp/src/lib/js/app/shared/baseTab.js`, `show(hashtag)` (line 121)

Add one line immediately after the function signature:

```js
async show(hashtag) {
  if (this.initialized && !this.tabLink.children('a').hasClass('active')) return;   // NEW
  this.initialized = true;
  this.tabLink.children('a').addClass('show active');
  this.tabContent.tab('show');
  return this.tabContent;
}
```

Nothing else changes in the file. The `shown.bs.tab` handler stays as-is. `hide()` stays as-is. No new event bindings.

## Verification (manual)

No automated test framework on the webapp today; defer that to its own sub-project.

1. `cd source/webapp && npm run build` — confirms no syntax error (the "build" is a copy step).
2. Serve `dist/` locally or deploy to a dev S3.
3. Chrome DevTools → Network → Slow 3G throttling.
4. **Repro before fix.** Click Settings → immediately click Collection. Confirm two panes stack.
5. **Verify after fix.** Same click sequence. Exactly one pane visible.
6. **Other top-level pairs.** Repeat for every adjacent pair (Collection↔Settings, Collection↔Stats, Stats↔Upload, Upload↔Settings, Settings↔Face Collection, etc.).
7. **No regression on slow nav.** Click Collection slowly, wait for full load. Sub-tabs (Video / Photo / Document) load and switch normally.
8. **No regression on hashtag deep-link.** Reload the app at `#settings/...` (or another deep-link path) and confirm the deep-linked tab still renders correctly.
9. **No regression on re-entry.** Click A → wait for full load → click B → click A again. A renders correctly the second time.

Pass: every scenario shows exactly one top-level pane; no stacking; sub-tab navigation unchanged; deep-links and re-entry still work.

## Risks

- **Other places that re-assert pane visibility.** If something outside `BaseTab.show()` calls `tab('show')` on a stale pane, the stacking can recur. During implementation: grep for `.tab('show')` in the webapp and confirm `baseTab.js:128` is the only call site.
- **Bootstrap class behavior assumption.** This fix relies on Bootstrap's tab plugin removing the `active` class from the previously-active nav-link before firing `shown.bs.tab` on the new one — which it does in Bootstrap 4. A future Bootstrap upgrade should re-validate this assumption.
- **Stale content in hidden pane.** A subclass `show()` whose `await` resolves after the user has switched away will still append content to its (now hidden) `tabContent`. Next time that tab is opened, the user may briefly see old data flushed in. Not blocking — flagged for follow-up if observed.

## Out of scope / follow-ups

- Subclass `show()` updates (collectionTab, statsTab, uploadTab, userManagementTab, faceCollectionTab, processingTab, mxAnalysisSettings) to also bail post-await — adds belt-and-suspenders against stale-content. User opted out for now.
- AbortController wiring through API helpers.
- Playwright e2e harness for regression coverage.
