# Horizon Weekly Planner — Implementation Spec

**Status:** ready to implement
**Scope:** new "Today spine + week strip" planner on the Horizon new-tab page, backed by a new bridge endpoint. Hermes provides optional AI suggestions; the planner must work fully without Hermes.

Read this whole document before writing code. Every section is normative unless marked "optional."

---

## 1. Background — the codebase you are working in

Horizon is a Chrome extension (Manifest V3) with a Python bridge to a local AI agent called Hermes.

| Path | What it is |
|---|---|
| `newtab/index.html` | The new-tab page markup |
| `newtab/app.js` | All new-tab logic. Module-level `state` object, `dom` element map, `init()` at the bottom |
| `newtab/hermes.js` | `window.HorizonHermes` — fetch wrappers for the bridge (IIFE, no modules) |
| `newtab/style.css` | All styles. Visibility toggling uses the `.hidden` class (`display: none !important`) |
| `background.js` | MV3 service worker: alarms, badge, notification polling |
| `bridge/bridge.py` | Python 3 stdlib HTTP server on `127.0.0.1:8942`. No third-party deps — keep it that way |
| `~/.horizon/` | Bridge data dir (`BRIDGE_DIR` in bridge.py). Contains `briefing.json`, `notifications.json` |

Existing patterns you MUST reuse (do not invent parallel mechanisms):

- **Persistence (extension):** everything lives in one object under the key `horizon:settings` in `chrome.storage.local`. `app.js` loads it into `state` on startup and has a save function that writes the whole object back. Find them: `grep -n "STORAGE_KEY" newtab/app.js`. Add new fields to `state` and they persist automatically through the existing save function — do not create new storage keys.
- **Persistence (bridge):** JSON files in `BRIDGE_DIR`, read with a try/except like `load_notifications()` in `bridge.py` (returns a safe default on missing/corrupt file), written with `Path.write_text(json.dumps(..., indent=2))`.
- **Calling Hermes:** `call_hermes(prompt, timeout)` in `bridge.py` runs the CLI and returns stdout or `None`. Parse its output with the existing `parse_hermes_json(text)` helper, which strips markdown fences and extracts JSON. Never assume Hermes returns clean JSON.
- **HTTP responses:** use the existing `self._send_json(data, status)` helper in `BridgeHandler`. It already sets CORS headers.
- **Fetch from the page:** add functions inside the `window.HorizonHermes` IIFE in `hermes.js`, following the shape of `getBriefing()` (base URL from `getBaseUrl()`, `AbortSignal.timeout(...)`, return `null` on any failure, never throw).
- **Visibility:** toggle the `.hidden` CSS class. Do NOT set `element.style.display` directly anywhere (there is one existing violation around the quote/briefing; do not copy it).
- **Todos:** already exist as `state.todos = [{ text: string, done: boolean }]` with a panel UI. The planner reads these; it does not replace the todo panel.

Known constraint: **the MV3 service worker (`background.js`) loses all in-memory state whenever Chrome suspends it (~30 s idle).** Anything that must survive goes in `chrome.storage.local`. The planner in this spec deliberately puts no logic in `background.js`, so you should not need to touch that file.

---

## 2. Product summary

Two new UI pieces on the new-tab page:

1. **Today spine** — a vertical list of at most 5 items for today: calendar events merged with AI-suggested task slots, ordered by time. Overflow collapses to "and N more".
2. **Week strip** — 7 small bars (Mon–Sun), one per day of the current week. Each bar encodes that day's scheduled load twice: by **color** (green = light, yellow = moderate, amber = heavy) and by **height** (taller = heavier). Both channels always agree; height exists so the strip works for colorblind users.

Architecture rule (the most important decision in this spec):

> **Tier 1 (deterministic):** the bridge merges local data (calendar events + todos) into the spine and week strip with plain Python. No LLM call in this path. It must return in well under 1 second.
>
> **Tier 2 (Hermes, async):** suggestions ("Draft Q3 review fits your open 2–3pm") come from a cached Hermes response refreshed in the background. If the cache is empty or stale, the API returns `suggestions: []` and the UI simply shows no suggestions. **Hermes being down, slow, or returning garbage must never blank or delay the planner.**

---

## 3. Bridge changes (`bridge/bridge.py`)

### 3.1 New files in `BRIDGE_DIR`

| File | Written by | Content |
|---|---|---|
| `plan_cache.json` | `refresh_plan_suggestions()` | `{ "generated_at": <unix seconds float>, "suggestions": [Suggestion, ...] }` |
| `plan_events.json` | Hermes cron / the refresh call | `{ "date": "YYYY-MM-DD", "events": [Event, ...], "week": { "YYYY-MM-DD": [Event, ...], ... } }` — cached calendar data so GET /api/plan never calls Hermes synchronously |

### 3.2 Data shapes (exact field names — the frontend depends on these)

```
Event = {
  "time": "HH:MM",          # 24h, e.g. "14:00". May be "" for all-day events.
  "end": "HH:MM" | null,     # optional; used for load hours. null => assume 1 hour.
  "title": str,
  "type": "event"
}

Suggestion = {
  "task": str,               # verbatim text of a todo item
  "slot": "HH:MM",          # proposed start time today, 24h
  "reason": str,             # <= 60 chars, e.g. "fits your open hour"
  "type": "suggestion"
}

DayLoad = {
  "day": "Mon",             # "Mon".."Sun"
  "date": "YYYY-MM-DD",
  "load": "none" | "light" | "moderate" | "heavy",
  "hours": float             # scheduled hours, rounded to 1 decimal
}
```

### 3.3 `GET /api/plan` (new endpoint, in `do_GET`)

Response — always HTTP 200, always this exact shape:

```json
{
  "date": "2026-07-17",
  "spine": [ /* Event and Suggestion objects, sorted by time/slot ascending */ ],
  "overflow": 0,
  "week": [ /* exactly 7 DayLoad objects, Monday first */ ],
  "suggestions_fresh": true
}
```

Implementation (all deterministic, no `call_hermes` here):

1. Load `plan_events.json`. If missing/corrupt or its `"date"` is not today, treat events as empty (`[]`) and week data as empty — do NOT call Hermes synchronously to fill it.
2. Load `plan_cache.json`. Discard suggestions if `generated_at` is older than **30 minutes** (set `suggestions_fresh: false` and use `[]`).
3. **Filter suggestions:** drop any suggestion whose `task` does not exactly match an incomplete todo sent by the frontend — but the bridge doesn't know the todos. Therefore: the frontend does this filtering (see §5.4). Bridge passes suggestions through as-is. (Written here so you don't add it in both places.)
4. Build the spine: today's events + fresh suggestions, sorted ascending by `time`/`slot` (empty-string times sort first). Keep the first **5**; set `overflow` to the count dropped.
5. Build `week`: for each of the 7 days of the current week (Monday-based), sum event durations from the cached week data. Duration of an event = `end - time` when both parse, else 1.0 hour. All-day events (empty `time`) count as 0 hours but any day containing one is at minimum `"light"`.
6. Load thresholds: `hours == 0` → `"none"`; `0 < hours < 2` → `"light"`; `2 <= hours <= 4` → `"moderate"`; `hours > 4` → `"heavy"`.

Helper functions to write: `load_plan_events()`, `load_plan_cache()` (both follow the `load_notifications()` pattern), `compute_week_load(week_events)`, `build_spine(events, suggestions)`. Keep them top-level functions with docstrings like the existing code.

### 3.4 `POST /api/plan/refresh` (new endpoint, in `do_POST`)

This is the ONLY place the planner calls Hermes. The frontend calls it in the background (fire-and-forget) when the cache is stale; it may take up to 30 s.

Body: `{ "todos": ["task text", ...] }` — the frontend sends its current incomplete todos.

Steps:

1. Call Hermes **once** for calendar data:
   ```
   call_hermes(
     "List my calendar events for the next 7 days. Respond with ONLY a JSON object, "
     "no prose, shaped exactly like: "
     '{"events": [{"date": "YYYY-MM-DD", "time": "HH:MM", "end": "HH:MM", "title": "..."}]}. '
     "Use 24-hour times. If an event is all-day, use \"time\": \"\". If you do not know the end time, omit \"end\".",
     timeout=25
   )
   ```
   Parse with `parse_hermes_json`. Validate: result must be a dict with an `"events"` list; each event must be a dict with string `date` and `title`. Drop malformed entries individually — one bad event must not discard the rest. Re-shape into `plan_events.json` format (today's events under `"events"`, all events grouped by date under `"week"`, `"date"` = today) and save it.
2. If step 1 returned usable events AND the request body contained a non-empty `todos` list, call Hermes a second time for suggestions:
   ```
   call_hermes(
     f"My calendar today: {json.dumps(today_events)}. "
     f"My open tasks: {json.dumps(todos)}. "
     "Suggest at most 2 tasks to schedule into free gaps today. Respond with ONLY a JSON array, "
     'no prose, shaped exactly like: [{"task": "<exact task text from my list>", "slot": "HH:MM", "reason": "<under 8 words>"}]. '
     "The task field must be copied verbatim from my task list. Only suggest slots in the future. "
     "If nothing fits, respond with [].",
     timeout=25
   )
   ```
   Parse and validate: must be a list; each item needs string `task`, `slot` matching `^\d{2}:\d{2}$`, string `reason`. Drop items whose `task` is not in the submitted todos (case-sensitive exact match). Add `"type": "suggestion"` to each. Save `{"generated_at": time.time(), "suggestions": [...]}` to `plan_cache.json`. On any failure, save `{"generated_at": time.time(), "suggestions": []}` — a failed refresh still resets the staleness clock so the frontend doesn't hammer retries.
3. Respond `{"refreshed": true, "suggestions": <count>}`.

### 3.5 `POST /api/plan/accept` (new endpoint, in `do_POST`)

Body: `{ "task": str, "slot": "HH:MM" }`. Validate both fields exist and are strings; otherwise `self._send_json({"error": "task and slot required"}, status=400)`.

1. Remove the matching suggestion (by `task`) from `plan_cache.json` and save it back.
2. Fire a memory write, mirroring the existing focus pattern:
   `call_hermes(f"Save this to memory: I scheduled the task '{task}' for {slot} today via the Horizon planner.", timeout=10)` — ignore the result.
3. Respond `{"accepted": true}`.

### 3.6 Update the docstring

Add the three new endpoints to the module docstring at the top of `bridge.py` (the existing endpoint list).

### 3.7 Pre-existing bug you must fix while in this file

`main()` constructs `HTTPServer(...)` and then calls `setsockopt(SO_REUSEADDR)` **after** the constructor — but `HTTPServer.__init__` already called `bind()`, so the option does nothing. The file already contains an unused `ReuseHTTPServer` class that sets the option correctly in `server_bind()`. Fix: in `main()`, replace `HTTPServer` with `ReuseHTTPServer` and delete the now-dead `setsockopt` line.

---

## 4. Frontend — `newtab/hermes.js`

Add two functions inside the `window.HorizonHermes` IIFE, following the existing style exactly (try/catch, return `null`/no-throw, timeouts via `AbortSignal.timeout`):

```js
// getPlan(): GET {base}/api/plan, timeout 3000 ms (it's deterministic and fast).
// Returns the parsed JSON or null.

// refreshPlan(todos): POST {base}/api/plan/refresh with body {todos},
// timeout 30000 ms. Fire-and-forget: callers do not await the result
// for rendering. Returns the parsed JSON or null.

// acceptSuggestion(task, slot): POST {base}/api/plan/accept with body
// {task, slot}, timeout 8000 ms. Returns parsed JSON or null.
```

Export all three in the IIFE's return object.

---

## 5. Frontend — new-tab UI

### 5.1 Markup (`newtab/index.html`)

Add one container, placed directly below the existing focus/briefing area (find the briefing widget markup and insert after it):

```html
<div id="planner" class="planner hidden">
  <div class="planner-header">
    <span class="planner-title">Today</span>
    <span class="planner-week-hint">this week</span>
  </div>
  <ul id="planner-spine" class="planner-spine"></ul>
  <div id="planner-overflow" class="planner-overflow hidden"></div>
  <div id="planner-week" class="planner-week"></div>
</div>
```

All rows and bars are built in JS; the HTML stays static.

### 5.2 Behavior (`newtab/app.js`)

Add to the `dom` map: `planner`, `plannerSpine`, `plannerOverflow`, `plannerWeek` (use the existing `$` helper).

Add to `state` defaults: `acceptedSuggestions: []` (array of `{ task, slot, date }` — records accepted suggestions so they render as committed items and survive reload).

**`loadPlanner()`** (new async function):

1. Guard: `if (!state.hermesEnabled || !window.HorizonHermes) return;`
2. `const plan = await window.HorizonHermes.getPlan();`
3. If `plan` is null → leave the planner hidden and return. (Bridge down = no planner. Do not show an error.)
4. `renderPlanner(plan)` then remove `.hidden` from `dom.planner`.
5. If `plan.suggestions_fresh === false`, fire a background refresh — do NOT await it before rendering:
   ```js
   const todos = state.todos.filter(t => !t.done).map(t => t.text);
   window.HorizonHermes.refreshPlan(todos).then(r => {
     if (r && r.refreshed) window.HorizonHermes.getPlan().then(p => { if (p) renderPlanner(p); });
   });
   ```

**`renderPlanner(plan)`** (new function). Must be idempotent — clear `plannerSpine` and `plannerWeek` with `innerHTML = ''` (or `replaceChildren()`) at the top, because it is called repeatedly.

Spine rows — for each item in `plan.spine`:

- Filter: drop suggestions whose `task` is not an incomplete todo (`state.todos.some(t => !t.done && t.text === item.task)`), and drop suggestions the user already accepted or dismissed this session.
- Build rows with `document.createElement` + `textContent` (the codebase's todo list does this — copy that approach). **Never interpolate event/task titles into `innerHTML`** — titles come from calendar data and could contain HTML. If you must use innerHTML for structure, pass all dynamic text through the existing `escapeHtml()`.
- Event row: time label, dot, title. If the event's `time` is in the past (compare against `new Date()`), add class `past`.
- Suggestion row: time label, sparkle marker (`✦` text glyph is fine), title, reason line, and two controls: an "Accept" button and a small "×" dismiss.
  - **Accept:** immediately convert the row to a committed event row (optimistic update), push `{ task, slot, date: todayISO }` onto `state.acceptedSuggestions`, call the existing settings-save function, then `window.HorizonHermes.acceptSuggestion(task, slot)` fire-and-forget.
  - **Dismiss:** remove the row and remember the task in a module-level `Set` (session-only is fine; do not persist dismissals).
- Accepted suggestions from `state.acceptedSuggestions` with `date === today` render as normal committed rows merged into the spine by time (and are excluded from the suggestion filter above). Entries with an older `date` are pruned in `loadPlanner()`.

Overflow: if `plan.overflow > 0`, set `plannerOverflow` text to `and ${plan.overflow} more` and unhide it; else hide it.

Week strip — for each of the 7 `DayLoad` objects, append a column div containing a bar div and a weekday label. Encode load twice:

| load | bar height | bar CSS class |
|---|---|---|
| `none` | 8px | `load-none` |
| `light` | 14px | `load-light` |
| `moderate` | 24px | `load-moderate` |
| `heavy` | 36px | `load-heavy` |

Set the height via inline `style.height` from a lookup object; color comes from the class (see §5.3). Add class `today` to the column whose `date` is today. Give each bar a `title` attribute like `"Thu · 5.5h scheduled"` for hover, and an `aria-label` with the same text.

**Wiring into `init()`:** find where `checkHermesBriefing` is scheduled (a `setTimeout(..., 2000)` and a `setInterval(..., 300000)` near the bottom of `app.js`). Add `loadPlanner` with the same pattern: `setTimeout(loadPlanner, 2500)` and `setInterval(loadPlanner, 300000)`, inside the same `hermesEnabled` guard.

### 5.3 Styles (`newtab/style.css`)

Append a `/* Planner */` section. Follow the visual language already in the file (translucent panels, existing font stack). Requirements:

- `.planner`: max-width 520px, centered, spacing consistent with the widgets around it.
- `.planner-spine`: plain list, no bullets; rows are flex: fixed-width right-aligned time (≈52px), marker, flexible title.
- `.past` rows: reduced opacity, line-through on the title.
- Suggestion rows: slightly distinct background; Accept is a small text button, not a heavy CTA.
- `.planner-week`: `display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; align-items: end;`
- Bar colors — colorblind-safe pairing with height, never red:
  ```css
  .load-none     { background: rgba(255,255,255,0.12); }
  .load-light    { background: #97C459; }
  .load-moderate { background: #FAC775; }
  .load-heavy    { background: #EF9F27; }
  ```
  Bars: `border-radius: 5px; width: 100%;`
- `.today` column: label at full opacity + subtle outline on the bar (`outline: 2px solid rgba(255,255,255,0.6); outline-offset: 2px;`); other day labels muted.
- Weekday labels: 11px, below the bars.

### 5.4 Rules recap (things a hasty implementation gets wrong)

1. **Render before Hermes.** `getPlan()` must render immediately from cache; the refresh happens after, and re-renders only on success.
2. **No suggestion for a completed/deleted todo.** Filter against current `state.todos` at render time (frontend responsibility — the bridge cannot know).
3. **Idempotent render.** `renderPlanner` fully clears its containers first; it runs every 5 minutes.
4. **Escape everything.** Calendar titles are untrusted text.
5. **Class toggling only.** `.hidden` for show/hide; no `style.display`.
6. **Accepted suggestions persist** (in `state.acceptedSuggestions` under the existing `horizon:settings` key); **dismissals do not** (session-only Set).
7. **No changes to `background.js`.** The planner has no service-worker component.

---

## 6. Failure-mode matrix (implement and verify every row)

| Condition | Required behavior |
|---|---|
| Bridge not running | Planner stays hidden. No console errors surfaced to the user, no retry storm (next attempt is the 5-min interval). |
| Bridge up, `plan_events.json` missing | `/api/plan` returns empty spine, `week` with all `"none"` loads, 200. UI shows the week strip of empty bars and no spine rows. |
| `plan_events.json` corrupt (invalid JSON) | Same as missing. Bridge must not 500. |
| Hermes CLI absent/erroring during refresh | `/api/plan/refresh` writes an empty-suggestions cache, returns `{"refreshed": true, "suggestions": 0}`. UI unchanged. |
| Hermes returns prose instead of JSON | `parse_hermes_json` returns None → treated as failure above. Bridge must not crash on `None`. |
| Hermes suggests a task not in the todo list | Dropped by bridge validation (§3.4 step 2) and again by frontend filter (§5.4.2). |
| Hermes suggests a past slot | Frontend renders it with `past` styling; acceptable. (Bridge-side filtering optional.) |
| Suggestion accepted, page reloaded | Row renders as a committed spine item (from `state.acceptedSuggestions`), not as a suggestion again. |
| Day changes overnight while tab stays open | The 5-min `loadPlanner` interval picks up the new date from `/api/plan`; stale `acceptedSuggestions` (date ≠ today) are pruned in `loadPlanner()`. |
| `hermesEnabled` is false | Planner never appears, no network calls. |

---

## 7. Manual test plan (run all of these before calling it done)

Setup: `python3 bridge/bridge.py`, load the extension unpacked, enable Hermes in Horizon settings.

1. **Cold start, no cache:** delete `~/.horizon/plan_*.json`, open a new tab → planner appears within ~3 s showing an empty week strip; within ~30 s (after refresh + re-fetch) events/suggestions appear if Hermes works.
2. **Warm cache:** reopen a tab → spine and strip render in under 1 s without waiting on Hermes.
3. **Bridge down:** kill bridge.py, open a tab → no planner, page otherwise normal.
4. **Corrupt cache:** write `not json` into both plan files → `curl http://localhost:8942/api/plan` returns 200 with empty data.
5. **Accept flow:** accept a suggestion → row converts instantly; reload → still a committed row; `plan_cache.json` no longer contains it.
6. **Dismiss flow:** dismiss a suggestion → gone; reload → it may reappear (expected, dismissals are session-only).
7. **Todo completion:** mark the suggested task done in the todo panel, wait for the next render (or reload) → suggestion no longer shows.
8. **XSS check:** add a calendar event titled `<img src=x onerror=alert(1)>` to `plan_events.json` by hand → title renders as literal text, no alert.
9. **Week strip encoding:** hand-edit `plan_events.json` to give one day 0h, one 1h, one 3h, one 6h → bars show none/light/moderate/heavy with strictly increasing heights and green/green/yellow/amber colors.
10. **Restart resilience:** Ctrl-C the bridge and restart it immediately → it binds without "Address already in use" (verifies §3.7).

---

## 8. Out of scope (do not build)

- Editing or creating calendar events from Horizon.
- A full week view (day columns with event titles). The strip is orientation only.
- Notifications/reminders for spine items.
- Any change to the command bar (it is intentionally disabled) or to `background.js`.
- Drag-and-drop, animations beyond simple transitions, settings UI for thresholds.
