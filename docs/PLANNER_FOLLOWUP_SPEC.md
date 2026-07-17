# Horizon Planner — Follow-up Spec: fixes + layout redesign

**Status:** ready to implement
**Prerequisite reading:** `docs/PLANNER_SPEC.md` (the original spec) and the current code. This spec fixes three confirmed bugs and redesigns the bottom-of-screen layout. Diagnoses below are verified — do not re-investigate, implement the fixes as written.

---

## 1. Confirmed bugs

### Bug 1 — Planner spine is always empty (refresh deadlock)

**Diagnosis (verified):** `GET /api/plan` returns `"spine": []` because `~/.horizon/plan_events.json` does not exist — it is only created by `POST /api/plan/refresh`. But in `newtab/app.js`, `loadPlanner()` only calls `refreshPlan()` when `plan.suggestions_fresh === false`. `plan_cache.json` exists with a recent `generated_at` and zero suggestions, so `suggestions_fresh` is `true`, the refresh never fires, and the events file is never created. Deadlock: no events → but cache "fresh" → no refresh → no events, forever.

**Fix (both sides):**

1. **Bridge (`bridge/bridge.py`):** in the `/api/plan` handler, add a top-level response field `events_fresh` (boolean): `true` only when `plan_events.json` exists, parsed successfully, AND its `"date"` equals today. The existing `suggestions_fresh` field keeps its current meaning.
2. **Frontend (`newtab/app.js`):** in `loadPlanner()`, change the refresh trigger from
   `if (plan.suggestions_fresh === false)` to
   `if (plan.events_fresh === false || plan.suggestions_fresh === false)`.
3. **Frontend, retry-storm guard:** a failed refresh writes a fresh empty cache (per the original spec), which resets `suggestions_fresh` — but `events_fresh` will remain `false` if Hermes returned no events, so every 5-minute `loadPlanner()` tick would re-trigger a 30 s Hermes call. Add a module-level variable `let lastPlanRefreshAt = 0;` and skip the refresh if `Date.now() - lastPlanRefreshAt < 10 * 60 * 1000` (10 minutes). Set it immediately before calling `refreshPlan()`.

**Acceptance:** delete `~/.horizon/plan_events.json` and `plan_cache.json`, reload a new tab → within ~30 s (one Hermes round-trip) `plan_events.json` exists with today's date and the spine shows calendar events. `curl http://localhost:8942/api/plan` shows `"events_fresh": true`.

### Bug 2 — Briefing card and planner overlap

**Diagnosis (verified):** `.briefing-widget` (in `newtab/style.css`) and `.planner` (in `newtab/style-planner.css`) are both `position: fixed`, anchored near the bottom center with overlapping vertical ranges. When both are visible they stack on top of each other. The briefing text is also clipped by the planner card sitting over it.

**Fix:** the dock redesign in §2 eliminates the second fixed element entirely. Do not fix this by nudging `bottom:` offsets — that breaks again the moment either card's content grows.

### Bug 3 — Stale briefing served on the wrong day

**Diagnosis (verified):** `~/.horizon/briefing.json` contains `"date": "2026-07-15"` and was served unchanged on 2026-07-17, producing "Protect your Wednesday" on a Friday.

**Fix (bridge):** in the `/api/briefing` handler in `bridge.py`, after loading the briefing, compare its `"date"` field to today (`time.strftime("%Y-%m-%d")`). If the field is present and does not match today, respond with `self._send_json({}, status=204)`... — actually a 204 must not carry a body, so instead return `self._send_json({"stale": true})` with status 200 and no `focus_suggestion` field. The frontend already guards with `if (briefing && briefing.focus_suggestion)` in `checkHermesBriefing()` (`newtab/app.js`), so a response without `focus_suggestion` shows nothing. If the briefing has no `"date"` field at all, serve it as-is (backward compatible).

**Acceptance:** with a `briefing.json` dated yesterday, `curl http://localhost:8942/api/briefing` returns `{"stale": true}` and the new-tab page shows no briefing card.

---

## 2. Layout redesign — one bottom dock

### 2.1 The problem with the current layout

Three separate surfaces compete for the bottom of the screen: the briefing card (fixed), the planner card (fixed), and the focus input (in the center column). Each was designed independently; together they collide and read as clutter. Screenshot evidence: briefing overlapping the planner, briefing text clipped mid-sentence, two stacked dark cards with different paddings.

### 2.2 The rule going forward

> **Exactly one fixed-position surface may exist at the bottom of the page: `#dock`.** Everything that previously floated there (briefing, planner) becomes a section *inside* the dock. Any future bottom-anchored UI must also go inside the dock. Never add another `position: fixed; bottom: ...` element to the new-tab page.

### 2.3 Dock structure (`newtab/index.html`)

Replace the current `#briefing` widget markup and the `#planner` markup with a single container (keep the inner element ids that JS already uses — listed below — so JS changes stay small):

```html
<div id="dock" class="dock hidden">
  <!-- Section 1: briefing (hidden unless there is a briefing) -->
  <div id="briefing" class="dock-briefing hidden">
    <p id="briefing-focus"></p>
    <p id="briefing-note" class="dock-briefing-note"></p>
    <button id="briefing-dismiss" aria-label="Dismiss briefing">×</button>
  </div>

  <!-- Section 2: today spine (hidden when empty) -->
  <div id="planner" class="dock-planner hidden">
    <div class="planner-header">
      <span class="planner-title">Today</span>
      <span class="planner-week-hint">this week</span>
    </div>
    <ul id="planner-spine" class="planner-spine"></ul>
    <div id="planner-overflow" class="planner-overflow hidden"></div>
  </div>

  <!-- Section 3: week strip (always visible when the dock is) -->
  <div id="planner-week" class="planner-week"></div>
</div>
```

Notes:

- `briefing-greeting` and `briefing-calendar` elements are removed. The greeting duplicated the page's main greeting ("Good afternoon, Satish" appeared twice in the screenshot); the calendar summary is superseded by the spine itself. In `showBriefing()` (`newtab/app.js`), delete the lines that set those two elements and keep only `briefing-focus` (the main sentence) and `briefing-note`.
- The quote-hiding logic tied to the old briefing widget (`dom.quoteText` show/hide) is unchanged in behavior but re-check it still references elements that exist after this restructure.
- Visibility logic: the dock itself unhides when ANY section has content. Add a small helper in `app.js`:
  ```js
  function updateDockVisibility() {
    const anyVisible = ['briefing', 'planner'].some(
      id => !document.getElementById(id).classList.contains('hidden')
    ) || dom.plannerWeek.children.length > 0;
    dom.dock.classList.toggle('hidden', !anyVisible);
  }
  ```
  Call it at the end of `showBriefing()`, the briefing dismiss handler, and `renderPlanner()`. Add `dock: $('#dock')` to the `dom` map.

### 2.4 Dock styles

Move all dock/planner/briefing styles into `style-planner.css` (rename mentally to "dock stylesheet"; keeping the filename is fine). Delete the old `.briefing-widget` fixed-position block from `style.css`.

```css
.dock {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  width: 90vw;
  max-width: 560px;
  background: var(--panel-bg);
  backdrop-filter: blur(20px);
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  padding: 16px 20px 14px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 45vh;
  overflow-y: auto;
}
.dock > * + * {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 14px;
}
```

Layout constraints (normative):

- **Vertical budget:** the dock must never cover the focus input. `max-height: 45vh` plus `bottom: 48px` guarantees this on any viewport ≥ 700px tall. On shorter viewports the dock scrolls internally rather than growing.
- **Briefing section:** single serif-feel sentence, `font-size: 15px; line-height: 1.6;`, no heading, dismiss `×` absolutely positioned top-right *of the section, not the dock*. No clipping: text wraps fully (`overflow-wrap: break-word`), never `text-overflow: ellipsis` on the main sentence.
- **Spine rows:** unchanged from the original spec (time gutter ≈ 52px right-aligned, marker, title).
- **Week strip:** stays at the bottom of the dock, full width. Bars per the original spec's height/color table. One change: give the strip a fixed row height (`height: 40px; align-items: end;`) so the dock doesn't jump when loads change.

### 2.5 Week-strip visual fixes (from screenshot review)

Current rendering problems and required changes:

1. **All-"none" days render as identical gray pills**, which reads as a disabled control, and the `today` outline (Fri in the screenshot) looks like a selected radio button. Change `load-none` to a nearly invisible baseline: `height: 3px; background: rgba(255,255,255,0.18); border-radius: 2px;` — a tick mark, not a pill.
2. **Today marker:** replace the outline ring with a small dot. Add below today's bar (between bar and label) a 4px circle: `background: rgba(255,255,255,0.9)`. Remove the `outline` styling entirely. Today's weekday label stays full-opacity white; other labels `rgba(255,255,255,0.55)`.
3. **Weekday labels:** currently `MON TUE WED...` — change to single letters `M T W T F S S` at `font-size: 10px; letter-spacing: 0.5px;`. Keep the full day name in the bar's `title`/`aria-label` (e.g. `"Friday · 2.5h scheduled"`).
4. **"THIS WEEK" hint label:** keep, but only in the planner header (it currently reads as a button — it is not one; ensure it has no hover/cursor styling).

### 2.6 Empty states (normative)

| State | Dock behavior |
|---|---|
| No briefing, no events, no suggestions, week all `none` | Dock hidden entirely. A wall of empty UI is worse than nothing. |
| Week has data but today's spine is empty | Planner section shows one muted line: `Nothing scheduled today` (13px, 55% white). Week strip visible. |
| Briefing exists, planner empty | Briefing section + week strip only; planner section hidden. |
| Events exist but Hermes suggestions absent | Spine shows events only. No placeholder for suggestions. |

Implement the "week all none" check as: every `DayLoad.load === "none"`.

---

## 3. Verification checklist (run all before done)

1. Delete `~/.horizon/plan_events.json` and `plan_cache.json`, restart bridge, open new tab → spine populates within ~30 s; `/api/plan` returns `"events_fresh": true` afterward.
2. Stop Hermes (or rename the CLI), delete the two cache files, open a new tab → dock stays hidden or shows only stale-free sections; confirm via console that refresh is attempted at most once per 10 minutes despite the 5-minute interval.
3. Backdate `briefing.json`'s `"date"` → no briefing card; `/api/briefing` returns `{"stale": true}`.
4. With both briefing and planner data present → one dock card, briefing above spine above strip, no overlap, focus input fully visible and clickable. Resize the window to 700px tall → dock scrolls internally, never covers the focus input.
5. Dismiss the briefing → briefing section collapses, dock stays (planner still has content), quote reappears per existing behavior.
6. All-empty state (no data at all) → no dock rendered.
7. Week strip: hand-edit `plan_events.json` with 0h/1h/3h/6h days → tick/short-green/medium-yellow/tall-amber bars; today shows a dot marker, not a ring.
8. No element on the page other than `#dock` has `position: fixed` with a `bottom` anchor (grep both CSS files to confirm).

## 4. Out of scope

- Any change to `background.js`, the command bar, or the todo panel.
- New bridge endpoints (only the two handler tweaks in §1).
- Animations beyond the existing `slideUp`.
