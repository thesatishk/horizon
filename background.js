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

chrome.alarms.create('refresh-briefing', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-briefing') {
    try {
      const data = await chrome.storage.local.get('horizon:settings');
      const settings = data['horizon:settings'];
      
      if (settings?.hermesEnabled) {
        // Ping Hermes to check availability
        const response = await fetch(`${settings.hermesUrl}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        
        if (response.ok) {
          // Update badge to show Hermes is connected
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