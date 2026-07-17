/**
 * Horizon Background Service Worker
 * 
 * Minimal service worker for Manifest V3.
 * Handles:
 * - Installation and update events
 * - Hermes API proxying (optional)
 * - Badge updates for focus reminders
 * - Alarm-based periodic refresh triggers
 */

// ============================================================
// Install / Update
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings
    chrome.storage.local.set({
      'horizon:settings': {
        name: '',
        clockFormat: '12',
        showSeconds: false,
        tempUnit: 'imperial',
        photoCategory: 'nature',
        hermesEnabled: false,
        hermesUrl: 'http://localhost:8942',
        focus: '',
        focusDone: false,
        todos: [],
        links: [
          {
            title: 'GitHub',
            url: 'https://github.com',
            favicon: 'https://www.google.com/s2/favicons?domain=github.com&sz=32',
          },
          {
            title: 'Gmail',
            url: 'https://mail.google.com',
            favicon: 'https://www.google.com/s2/favicons?domain=mail.google.com&sz=32',
          },
          {
            title: 'YouTube',
            url: 'https://youtube.com',
            favicon: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32',
          },
        ],
      },
    });
  }

  if (details.reason === 'update') {
    console.log(`Horizon updated to ${chrome.runtime.getManifest().version}`);
  }
});

// ============================================================
// Periodic checks
// ============================================================

chrome.alarms.create('poll-notifications', { periodInMinutes: 2 });
chrome.alarms.create('refresh-briefing', { periodInMinutes: 5 });

async function getShownIds() {
  const data = await chrome.storage.local.get('horizon:shown-notifications');
  return new Set(data['horizon:shown-notifications'] || []);
}

async function addShownId(id) {
  const shown = await getShownIds();
  shown.add(id);
  await chrome.storage.local.set({ 'horizon:shown-notifications': [...shown] });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'poll-notifications') {
    try {
      const data = await chrome.storage.local.get('horizon:settings');
      const settings = data['horizon:settings'];
      if (!settings?.hermesEnabled) return;

      const response = await fetch(`${settings.hermesUrl}/api/notifications`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      
      const { notifications } = await response.json();
      if (!notifications || notifications.length === 0) {
        chrome.action?.setBadgeText?.({ text: '' });
        return;
      }

      const shownIds = await getShownIds();
      
      // Compute new count BEFORE adding to shown set
      const newNotifications = notifications.filter(n => !shownIds.has(n.id));
      if (newNotifications.length > 0) {
        chrome.action?.setBadgeText?.({ text: String(newNotifications.length) });
        chrome.action?.setBadgeBackgroundColor?.({ color: '#f59e0b' });
      }

      // Show new notifications
      for (const n of newNotifications) {
        await addShownId(n.id);
        chrome.notifications?.create?.(n.id, {
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: n.title,
          message: n.body,
          priority: n.urgency === 'now' ? 2 : 0,
        });
      }
    } catch {
      // Bridge not available
    }
  }

  if (alarm.name === 'refresh-briefing') {
    try {
      const data = await chrome.storage.local.get('horizon:settings');
      const settings = data['horizon:settings'];
      
      if (settings?.hermesEnabled) {
        const response = await fetch(`${settings.hermesUrl}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        
        if (response.ok) {
          chrome.action?.setBadgeText?.({ text: '●' });
          chrome.action?.setBadgeBackgroundColor?.({ color: '#4ade80' });
        } else {
          chrome.action?.setBadgeText?.({ text: '' });
        }
      }
    } catch {
      chrome.action?.setBadgeText?.({ text: '' });
    }
  }
});

// ============================================================
// Message passing
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-briefing') {
    // Forward briefing request to Hermes and respond
    handleBriefingRequest().then(sendResponse);
    return true; // keep the message channel open
  }
});

async function handleBriefingRequest() {
  try {
    const data = await chrome.storage.local.get('horizon:settings');
    const settings = data['horizon:settings'];
    if (!settings?.hermesEnabled) return null;

    const response = await fetch(`${settings.hermesUrl}/api/briefing`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return await response.json();
  } catch {}
  return null;
}