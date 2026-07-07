// background.js - Service Worker for Dopes Gatekeeper

let activeTabId = null;
let windowFocused = true;
let timeSpent = 0; // seconds, shared across all tracked domains
let restUntil = 0; // timestamp (ms) until which ALL tracked domains are resting

// Load timeSpent and restUntil from storage
chrome.storage.local.get(['timeSpent', 'restUntil'], (result) => {
  timeSpent = result.timeSpent || 0;
  restUntil = result.restUntil || 0;
});

// Recover current window focus state (module state is lost whenever the
// MV3 service worker is suspended and restarted)
chrome.windows.getLastFocused({}, (win) => {
  windowFocused = !!win && win.focused;
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
});

// content_scripts only auto-inject on navigation, so tabs that were already
// open before the extension was installed/reloaded never get content.js.
// Inject it into them manually so tracking works without a manual refresh.
async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (err) {
      // Page not injectable (e.g. Chrome Web Store) - ignore
    }
  }
}
chrome.runtime.onInstalled.addListener(injectIntoExistingTabs);
chrome.runtime.onStartup.addListener(injectIntoExistingTabs);

// Tracked domains and their display names (used by the popup for readability)
const DOMAIN_LABELS = {
  'youtube.com': 'YouTube',
  'twitch.tv': 'Twitch',
  'instagram.com': 'Instagram',
  'iyf.tv': 'iYF',
  'bilibili.com': 'Bilibili'
};
const TRACKED_DOMAINS = Object.keys(DOMAIN_LABELS);

// Allowance/break presets, shared across all tracked domains
const MODES = {
  standard: { allowance: 30 * 60, restTime: 10 * 60 },
  extended: { allowance: 45 * 60, restTime: 15 * 60 }
};

let mode = 'standard';
chrome.storage.local.get(['mode'], (result) => {
  mode = MODES[result.mode] ? result.mode : 'standard';
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.mode) {
    mode = MODES[changes.mode.newValue] ? changes.mode.newValue : 'standard';
  }
});

const INPUT_IDLE_MS = 60000; // stop counting plain browsing after this long without input

// Function to get domain from URL
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Function to normalize a hostname to the tracked domain key (e.g. "www.youtube.com" -> "youtube.com")
function normalizeDomain(hostname) {
  if (!hostname) return null;
  for (const domain of TRACKED_DOMAINS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return domain;
    }
  }
  return null;
}

// Function to trigger rest - blocks ALL tracked domains (all tabs, incl. refreshes) for restTime,
// since they share a single allowance.
function triggerRest() {
  console.log('Shared allowance reached! Showing overlay.');

  const restTime = MODES[mode].restTime;
  restUntil = Date.now() + restTime * 1000;
  chrome.storage.local.set({ restUntil });

  // Show the overlay on every open tab currently on any tracked domain
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (normalizeDomain(getDomain(tab.url))) {
        chrome.tabs.sendMessage(tab.id, { action: 'showOverlay', restTime })
          .catch((err) => console.log('Could not deliver overlay message:', err));
      }
    }
  });

  // Reset timer
  timeSpent = 0;
  chrome.storage.local.set({ timeSpent });
}

// Content scripts ask this on load (covers refreshes and new tabs) to find out
// whether the shared allowance is currently resting, and if so for how much longer.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkResting' && sender.tab && sender.tab.url) {
    const domain = normalizeDomain(getDomain(sender.tab.url));
    const remainingMs = domain ? restUntil - Date.now() : 0;
    if (domain && restUntil && remainingMs <= 0) {
      restUntil = 0;
      chrome.storage.local.set({ restUntil });
    }
    sendResponse({ restRemainingMs: Math.max(remainingMs, 0) });
  } else if (message.action === 'getStatus') {
    const remainingMs = restUntil - Date.now();
    sendResponse({
      timeSpent,
      allowance: MODES[mode].allowance,
      domains: TRACKED_DOMAINS,
      domainLabels: DOMAIN_LABELS,
      restRemainingMs: remainingMs > 0 ? remainingMs : 0,
      mode
    });
  }
});

// Listen to tab activation
chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
});

// Listen to tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    activeTabId = null;
  }
});

// Periodic engagement check every second. "Engaged" means either a video is
// actively playing (cursor doesn't move while watching) or the user has
// provided input recently (plain browsing/scrolling).
setInterval(() => {
  if (!activeTabId || !windowFocused) return;

  chrome.tabs.get(activeTabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;

    const domain = normalizeDomain(getDomain(tab.url));
    if (!domain) return;
    if (restUntil > Date.now()) return; // already resting

    chrome.tabs.sendMessage(activeTabId, { action: 'getEngagement' })
      .then((response) => {
        const engaged = response && (response.videoPlaying || response.idleMs < INPUT_IDLE_MS);
        if (!engaged) return;

        timeSpent += 1;
        chrome.storage.local.set({ timeSpent });
        if (timeSpent >= MODES[mode].allowance) {
          triggerRest();
        }
      })
      .catch(() => {
        // No content script on this tab (e.g. chrome:// page) - nothing to measure
      });
  });
}, 1000);