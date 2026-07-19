// background.js - Service Worker for Dopes Gatekeeper
//
// Content scripts on tracked domains decide whether a watchable video is
// playing (visible tab or picture-in-picture) and push one 'videoTick'
// message per second of playback. This worker just counts those seconds
// against the shared allowance and enforces the rest period. The push model
// also means every counted second wakes the service worker, so tracking
// survives MV3 worker suspension.

const TRACKED_DOMAINS = ['youtube.com', 'twitch.tv', 'instagram.com', 'iyf.tv', 'bilibili.com'];
const TRACKED_URL_PATTERNS = TRACKED_DOMAINS.map((d) => `*://*.${d}/*`);

// Allowance/break presets, shared across all tracked domains
const MODES = {
  standard: { allowance: 30 * 60, restTime: 10 * 60 },
  extended: { allowance: 45 * 60, restTime: 15 * 60 }
};

let timeSpent = 0; // seconds watched, shared across all tracked domains
let restUntil = 0; // timestamp (ms) until which ALL tracked domains are resting
let mode = 'standard';
let lastTickMs = 0; // dedupes ticks from multiple tabs within the same second

// Module state is lost whenever the MV3 worker is suspended and restarted;
// handlers await this so a tick arriving right after a restart can't count
// against uninitialized state.
// Users can drop extra cat photos into png/ as dopes_1.png, dopes_2.png, ...
// Extension packages can't be enumerated at runtime, so probe the numbered
// names until the first gap and remember how many exist. The overlay picks
// one at random from that count.
const MAX_PHOTOS = 50;
let photoCount = 1;
const photosReady = (async () => {
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    try {
      const res = await fetch(chrome.runtime.getURL(`png/dopes_${i}.png`));
      if (!res.ok) break;
      photoCount = i;
    } catch {
      break;
    }
  }
})();

// Earlier versions stored these as per-domain objects; an object would turn
// `timeSpent += 1` into string concatenation and the allowance check would
// never fire, so accept nothing but finite numbers.
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const stateReady = new Promise((resolve) => {
  chrome.storage.local.get(['timeSpent', 'restUntil', 'mode'], (result) => {
    timeSpent = asNumber(result.timeSpent);
    restUntil = asNumber(result.restUntil);
    mode = MODES[result.mode] ? result.mode : 'standard';
    resolve();
  });
});

// This worker is the only writer of timeSpent/restUntil, so only mode (written
// by the options page) needs syncing back in.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.mode) mode = MODES[changes.mode.newValue] ? changes.mode.newValue : 'standard';
});

// Persisting every counted second would mean one disk write per second of
// playback. Batch instead: write at most every 15s, plus forced flushes at
// the moments that matter (rest trigger, reset, worker shutdown). Worst case
// on an unclean worker death is losing ~14s of counted time.
let lastFlushMs = 0;
function flushState(force = false) {
  const now = Date.now();
  if (!force && now - lastFlushMs < 15000) return;
  lastFlushMs = now;
  chrome.storage.local.set({ timeSpent, restUntil });
}
chrome.runtime.onSuspend.addListener(() => flushState(true));

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

// The manifest only auto-injects into frames whose own URL is on a tracked
// domain. Cross-origin player iframes inside tracked tabs (and tracked tabs
// already open when the extension loads) are covered by manual injection;
// the content script's injection guard makes overlap a no-op.
function injectIntoTab(tabId) {
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    .catch(() => {
      // Page not injectable (e.g. Chrome Web Store) - ignore
    });
}

async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({ url: TRACKED_URL_PATTERNS });
  for (const tab of tabs) {
    injectIntoTab(tab.id);
  }
}
chrome.runtime.onInstalled.addListener(injectIntoExistingTabs);
chrome.runtime.onStartup.addListener(injectIntoExistingTabs);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 'complete' catches iframes present at load; an 'audible' flip catches
  // player iframes mounted later that started making sound
  const relevant = changeInfo.status === 'complete' || changeInfo.audible === true;
  if (!relevant || !tab.url || !normalizeDomain(getDomain(tab.url))) return;
  injectIntoTab(tabId);
});

// Function to trigger rest - blocks ALL tracked domains (all tabs, incl. refreshes) for restTime,
// since they share a single allowance.
function triggerRest() {
  console.log('Shared allowance reached! Showing overlay.');

  const restTime = MODES[mode].restTime;
  restUntil = Date.now() + restTime * 1000;
  timeSpent = 0;
  flushState(true);

  // Show the overlay on every open tab currently on any tracked domain
  chrome.tabs.query({ url: TRACKED_URL_PATTERNS }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'showOverlay', restTime, photoCount })
        .catch((err) => console.log('Could not deliver overlay message:', err));
    }
  });
}

// One second of watchable video playback, reported by a tracked tab.
// Returns the remaining rest ms so the sender can self-heal a missed overlay.
async function handleVideoTick(sender) {
  await stateReady;
  if (!sender.tab || !sender.tab.url) return 0;
  if (!normalizeDomain(getDomain(sender.tab.url))) return 0; // only tracked domains count

  const now = Date.now();
  if (restUntil > now) return restUntil - now; // already resting

  if (now - lastTickMs >= 900) { // several tabs may tick in the same second
    lastTickMs = now;
    timeSpent += 1;
    if (timeSpent >= MODES[mode].allowance) {
      triggerRest();
    } else {
      flushState();
    }
  }

  return restUntil > Date.now() ? restUntil - Date.now() : 0;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'videoTick') {
    handleVideoTick(sender).then((remainingMs) => sendResponse({ restRemainingMs: remainingMs }));
    return true; // async sendResponse
  }

  // Content scripts ask this on load (covers refreshes and new tabs) to find
  // out whether their domain is tracked and currently resting.
  if (message.action === 'checkResting') {
    (async () => {
      await stateReady;
      await photosReady;
      const domain = sender.tab && sender.tab.url ? normalizeDomain(getDomain(sender.tab.url)) : null;
      const remainingMs = domain ? restUntil - Date.now() : 0;
      if (domain && restUntil && remainingMs <= 0) {
        restUntil = 0;
        flushState(true);
      }
      sendResponse({ tracked: !!domain, restRemainingMs: Math.max(remainingMs, 0), photoCount });
    })();
    return true; // async sendResponse
  }

  if (message.action === 'getStatus') {
    (async () => {
      await stateReady;
      const remainingMs = restUntil - Date.now();
      sendResponse({
        timeSpent,
        allowance: MODES[mode].allowance,
        restRemainingMs: Math.max(remainingMs, 0),
        mode
      });
    })();
    return true; // async sendResponse
  }

  if (message.action === 'resetTimer') {
    (async () => {
      await stateReady;
      timeSpent = 0;
      const wasResting = restUntil > Date.now();
      restUntil = 0; // resetting also cancels an active rest
      flushState(true);
      if (wasResting) {
        chrome.tabs.query({ url: TRACKED_URL_PATTERNS }, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action: 'clearOverlay' }).catch(() => {});
          }
        });
      }
      sendResponse({});
    })();
    return true; // async sendResponse
  }
});
