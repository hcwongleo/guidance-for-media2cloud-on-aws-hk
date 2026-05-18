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

## Approach (chosen): `isActive` boolean gate in `BaseTab`

Add a single boolean to `BaseTab`. Set `true` when `shown.bs.tab` fires for this tab. Set `false` when `hide.bs.tab` fires. Just before `BaseTab.show()` performs its DOM mutation (the line that re-asserts the pane as active), check the boolean — if it's false, bail.

This works *with single-file scope* because every subclass `show()` ends by calling `super.show()`, which performs the load-bearing `this.tabContent.tab('show')`. By gating that single call site, we prevent any in-flight render from re-asserting itself, regardless of how many awaits the subclass had.

### Why a boolean, not an epoch counter

An earlier draft of this design used a monotonic epoch counter so the rare "rapid double-click on the same tab" case (two `show()` invocations on tab A racing each other) would be caught. With single-file scope, the epoch can only be captured inside `BaseTab.show()` itself — which has no internal awaits — so the capture-then-check pattern is a no-op. The epoch counter only earns its keep when subclasses cooperate (capture epoch at their start, check after each await). Since subclass changes are out of scope, the epoch adds complexity without functional benefit. The double-click-same-tab case isn't a real concern either: Bootstrap's `shown.bs.tab` does not fire when the already-active tab is clicked again.

### Approaches considered and rejected

- **`AbortController` per fetch.** Cancels network too, but the webapp's API helpers don't currently accept a `signal` — bigger surgery for marginal benefit. Can layer in later.
- **Block tab clicks while loading.** Disabling nav until the current load finishes feels sluggish; user explicitly preferred immediate switching.
- **Render-epoch counter.** See above — wrong tool for single-file scope.

## Scope (chosen)

**Single file:** `source/webapp/src/lib/js/app/shared/baseTab.js`.

The base-class change is load-bearing — gating `tab('show')` is what stops Bootstrap from re-asserting the stale pane. Subclasses that also append DOM after a long `await` may briefly flush stale content into a hidden pane, but this only manifests as stale content the *next* time the tab is opened, not as visible stacking. Acceptable trade-off for the smaller change set; revisit if a regression is reported.

Out of scope:

- Sub-tabs inside Collection (Video / Photo / Document / Podcast / Search).
- Analysis-component sub-views (`baseAnalysisTab.js`, `analysisComponent.js`, etc.).
- Bootstrap version upgrade.
- Test framework setup.

## Implementation

### `source/webapp/src/lib/js/app/shared/baseTab.js`

Two additions and one gate:

1. **Constructor:** initialize `this.$isActive = false;`.
2. **Constructor:** in the existing `shown.bs.tab` handler, set `this.$isActive = true;` immediately before `await this.show();`.
3. **Constructor:** bind `hide.bs.tab` on the same anchor → `this.$isActive = false;`. (Note: do **not** also call existing `hide()` — that resets `initialized = false` and would force a full re-render every time a tab loses focus, which is a perf regression. Pane content stays in place.)
4. **`show(hashtag)`:** at the very top, check `if (!this.$isActive) return;` before any DOM mutation.

### Pseudo-diff

```js
constructor(title, options = {}) {
  // ...existing field setup...

  this.$isActive = false;                  // NEW

  anchor.on('shown.bs.tab', async (event) => {
    const target = $(event.target);
    target.parent().siblings()
      .children('.nav-link')
      .removeClass('show active');
    if (target.prop('id') === this.tabId) {
      this.$isActive = true;               // NEW
      await this.show();
    }
    return true;
  });

  anchor.on('hide.bs.tab', () => {         // NEW
    this.$isActive = false;
  });

  this.$initialized = false;
}

async show(hashtag) {
  if (!this.$isActive) return;             // NEW gate
  this.initialized = true;
  this.tabLink.children('a').addClass('show active');
  this.tabContent.tab('show');
  return this.tabContent;
}
```

## Verification (manual)

No automated test framework on the webapp today; defer that to its own sub-project.

1. `cd source/webapp && npm run build` — confirms no syntax error (the "build" is a copy step).
2. Serve `dist/` locally or deploy to a dev S3.
3. Chrome DevTools → Network → Slow 3G throttling.
4. **Repro before fix.** Click Settings → immediately click Collection. Confirm two panes stack.
5. **Verify after fix.** Same click sequence. Exactly one pane visible.
6. **Other top-level pairs.** Repeat for every adjacent pair (Collection↔Settings, Collection↔Stats, Stats↔Upload, Upload↔Settings, Settings↔Face Collection, etc.).
7. **No regression on slow nav.** Click Collection slowly, wait for full load. Sub-tabs (Video / Photo / Document) load and switch normally.
8. **No regression on hashtag-deep-link.** Reload the app at `#settings/...` and confirm the deep-linked tab still renders.

Pass: every scenario shows exactly one top-level pane; no stacking; sub-tab navigation unchanged; deep-links still work.

## Risks

- **Other places that re-assert pane visibility.** If something outside `BaseTab.show()` calls `tab('show')` on a stale pane, the stacking can recur. During implementation: grep for `.tab('show')` in the webapp and confirm `baseTab.js:128` is the only call site.
- **Stale content in hidden pane.** A subclass `show()` whose `await` resolves after the user has switched away will still append content to its (now hidden) `tabContent`. Next time that tab is opened, the user may briefly see old data flushed in. Not blocking — flagged for follow-up if observed.
- **Initial render race.** `mainView.show()` (one-time, at app boot) is `await this.hide(); ... this._show(hashtag)`, where the very first show happens before any user click and therefore before any `shown.bs.tab` has fired — so `$isActive` is false at that moment. Need to confirm `mainView` directly invokes the target tab's `show()` (yes, line 171: `this.tabControllers[name].show(next)`); that path bypasses `shown.bs.tab` and would therefore be incorrectly gated. **Mitigation:** also set `$isActive = true` in the existing `BaseTab.show()` if needed, OR have `mainView._show()` set `$isActive = true` on the target tab before invoking. Decision deferred to implementation; verification step 8 (deep-link) catches it.

## Out of scope / follow-ups

- Subclass `show()` updates (collectionTab, statsTab, uploadTab, userManagementTab, faceCollectionTab, processingTab, mxAnalysisSettings) to also bail post-await — adds belt-and-suspenders against stale-content. User opted out for now.
- AbortController wiring through API helpers.
- Playwright e2e harness for regression coverage.
- Render-epoch counter (would handle the rapid-double-click-same-tab case if subclasses cooperate; not currently a real Bootstrap behavior).
