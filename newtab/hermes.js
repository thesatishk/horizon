/**
 * Horizon Hermes Bridge
 * 
 * Connects Horizon to a local Hermes agent instance for:
 * - Daily briefing (focus suggestions, calendar summaries, weather context)
 * - Live command-bar queries (knowledge retrieval, email search, file lookup)
 * - Ambient context updates
 * 
 * All communication happens over localhost. No data leaves the machine.
 */

window.HorizonHermes = (function () {
  'use strict';

  const DEFAULT_URL = 'http://localhost:8942';

  /**
   * Get the Hermes API base URL from extension storage.
   */
  async function getBaseUrl() {
    try {
      const data = await chrome.storage.local.get('horizon:settings');
      if (data['horizon:settings']?.hermesUrl) {
        return data['horizon:settings'].hermesUrl;
      }
    } catch {}
    return DEFAULT_URL;
  }

  /**
   * Query Hermes with a natural language request.
   * Returns an array of result objects: [{ title, detail, url, action }]
   */
  async function query(text) {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          context: 'horizon-newtab',
          max_results: 5,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data.results || [];
    } catch {
      return null;
    }
  }

  /**
   * Fetch the daily briefing from Hermes.
   * Hermes cron jobs write this to a local JSON file,
   * or we fetch it from the Hermes API.
   */
  async function getBriefing() {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/briefing`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Check if Hermes is reachable.
   */
  async function isAvailable() {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Set today's focus via Hermes, so it's available in Hermes memory too.
   */
  async function setFocus(text) {
    const base = await getBaseUrl();
    try {
      await fetch(`${base}/api/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: text }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Silent fail — focus is still stored locally
    }
  }

  /**
   * Get upcoming calendar events from Hermes.
   */
  async function getCalendar() {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/calendar?limit=5`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.events || [];
    } catch {
      return [];
    }
  }

  /**
   * Get the planner data (spine + week strip). Fast, deterministic.
   */
  async function getPlan() {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/plan`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Trigger a background refresh of calendar events + Hermes suggestions.
   * Fire-and-forget — callers should not await for rendering.
   */
  async function refreshPlan(todos) {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/plan/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todos }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Accept a planner suggestion — removes it from cache, logs to Hermes memory.
   */
  async function acceptSuggestion(task, slot) {
    const base = await getBaseUrl();
    try {
      const response = await fetch(`${base}/api/plan/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, slot }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  // Public API
  return {
    query,
    getBriefing,
    isAvailable,
    setFocus,
    getCalendar,
    getPlan,
    refreshPlan,
    acceptSuggestion,
  };
})();