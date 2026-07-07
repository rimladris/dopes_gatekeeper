// content.js - Content Script for Dopes Gatekeeper

// Guard against double-injection (e.g. manifest injection on next navigation
// racing with a one-time chrome.scripting.executeScript call into a tab that
// was already open when the extension loaded)
if (window.__dopesGatekeeperInjected) {
  // no-op: already running in this document
} else {
window.__dopesGatekeeperInjected = true;

// Track whether any <video> on the page is actively playing, and the last
// time the user provided input. Used by background.js to decide whether the
// user is "engaged" (watching video doesn't move the cursor, so video
// playback counts as engagement on its own; plain browsing relies on input).
let videoPlaying = false;
let lastInputTime = Date.now();

function isAnyVideoPlaying() {
  return Array.from(document.querySelectorAll('video')).some(
    (v) => !v.paused && !v.ended && v.readyState > 2
  );
}

function trackVideo(video) {
  if (video.dataset.dopesTracked) return;
  video.dataset.dopesTracked = '1';
  video.addEventListener('play', () => { videoPlaying = true; });
  video.addEventListener('pause', () => { videoPlaying = isAnyVideoPlaying(); });
  video.addEventListener('ended', () => { videoPlaying = isAnyVideoPlaying(); });
}

document.querySelectorAll('video').forEach(trackVideo);
videoPlaying = isAnyVideoPlaying();

// document.documentElement exists even at document_start, unlike document.body
new MutationObserver(() => {
  document.querySelectorAll('video').forEach(trackVideo);
  videoPlaying = isAnyVideoPlaying();
}).observe(document.documentElement, { childList: true, subtree: true });

['scroll', 'keydown', 'mousedown', 'click', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, () => { lastInputTime = Date.now(); }, { passive: true, capture: true });
});

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showOverlay') {
    showOverlay(message.restTime);
  } else if (message.action === 'getEngagement') {
    sendResponse({ videoPlaying, idleMs: Date.now() - lastInputTime });
  }
});

// On every load (including refreshes) check whether this domain is already
// resting, so a refresh doesn't bypass the overlay.
chrome.runtime.sendMessage({ action: 'checkResting' })
  .then((response) => {
    if (response && response.restRemainingMs > 0) {
      showOverlay(response.restRemainingMs / 1000);
    }
  })
  .catch(() => {});

function showOverlay(restTimeSeconds) {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => showOverlay(restTimeSeconds), { once: true });
    return;
  }

  // Create overlay div
  const overlay = document.createElement('div');
  overlay.id = 'dopes-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.pointerEvents = 'auto';

  // Create image element
  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('png/dopes_1.png');
  img.style.maxWidth = '50%';
  img.style.maxHeight = '50%';
  img.style.objectFit = 'contain';

  // Add text
  const text = document.createElement('div');
  text.textContent = 'TIME TO REST! 🐈';
  text.style.color = 'white';
  text.style.fontSize = '24px';
  text.style.marginTop = '20px';

  overlay.appendChild(img);
  overlay.appendChild(text);

  // Prevent interactions
  overlay.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('keydown', (e) => e.stopPropagation());
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  // Disable body interactions
  document.body.style.pointerEvents = 'none';
  document.body.style.userSelect = 'none';

  document.body.appendChild(overlay);

  // Remove after rest time
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
      document.body.style.pointerEvents = '';
      document.body.style.userSelect = '';
    }
  }, restTimeSeconds * 1000);
}

}