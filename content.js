// content.js - Content Script for Dopes Gatekeeper
//
// Runs in every frame (all_frames: true) so players hosted in cross-origin
// iframes are seen too. Each frame detects its own watchable playback and
// ticks the background independently; the background dedupes ticks and
// validates the tab's domain. During a rest, every frame pauses its media,
// but only the top frame draws the overlay.

// Guard against double-injection (e.g. manifest injection on next navigation
// racing with a one-time chrome.scripting.executeScript call into a tab that
// was already open when the extension loaded)
if (window.__dopesGatekeeperInjected) {
  // no-op: already running in this document
} else {
window.__dopesGatekeeperInjected = true;

const isTopFrame = window === window.top;
let restActive = false;

// Collect media elements including those inside (open) shadow roots, which
// querySelectorAll alone doesn't reach
function collectMedia(selector, root = document, out = []) {
  root.querySelectorAll(selector).forEach((el) => out.push(el));
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) collectMedia(selector, el.shadowRoot, out);
  });
  return out;
}

function isPlaying(v) {
  return !v.paused && !v.ended && v.readyState > 2;
}

// A playing video is "watchable" when it is on-screen and either audible or
// large enough to be the main content (filters muted hover/feed autoplays)
function isWatchable(v) {
  if (!isPlaying(v)) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = v.getBoundingClientRect();
  const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  if (!onScreen) return false;
  const audible = !v.muted && v.volume > 0;
  const bigEnough = r.width * r.height >= 0.15 * vw * vh;
  return audible || bigEnough;
}

// Shadow-DOM players are rare, and the deep scan that finds them (walking
// every element looking for shadow roots) is the expensive part of watch
// detection. Per-second checks use the cheap tag query; the deep scan only
// runs as a fallback when that finds nothing, at most every 5 seconds, with
// its finds cached in between.
let shadowVideos = [];
let ticksSinceShadowScan = 5;

// "Being watched" means a human can plausibly see the playing video:
// - picture-in-picture counts even while its tab is hidden
// - otherwise the tab must be visible: the selected tab of a window that is
//   not minimized or fully covered. Chrome's occlusion tracking makes
//   visibilityState handle second monitors, unfocused windows, and partial
//   overlap correctly - focus is NOT required, only being on screen.
function isWatchableVideoPlaying() {
  const pip = document.pictureInPictureElement;
  if (pip && isPlaying(pip)) return true;

  if (document.visibilityState !== 'visible') return false;

  const vids = document.querySelectorAll('video');
  for (const v of vids) {
    if (isWatchable(v)) return true;
  }

  ticksSinceShadowScan++;
  if (ticksSinceShadowScan >= 5) {
    ticksSinceShadowScan = 0;
    shadowVideos = collectMedia('video').filter((v) => v.getRootNode() !== document);
  } else {
    shadowVideos = shadowVideos.filter((v) => v.isConnected);
  }
  return shadowVideos.some(isWatchable);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'showOverlay') {
    enterRest(message.restTime);
  }
});

// On load, ask the background whether this domain is tracked and whether a
// rest is in progress (covers refreshes and new tabs during a rest). If
// tracked, start reporting watch time: one message per second of watchable
// playback. Pushing (rather than the background polling) means every counted
// second wakes the MV3 service worker, so it can never sleep through playback.
chrome.runtime.sendMessage({ action: 'checkResting' })
  .then((response) => {
    if (!response || !response.tracked) return;
    if (response.restRemainingMs > 0) {
      enterRest(response.restRemainingMs / 1000);
    }
    const tickerId = setInterval(() => {
      // When the extension is reloaded, scripts already in open pages are
      // orphaned: chrome.runtime.id becomes undefined and sendMessage throws
      // synchronously. Go quiet - the newly injected script takes over.
      if (!chrome.runtime?.id) {
        clearInterval(tickerId);
        return;
      }
      if (!restActive && isWatchableVideoPlaying()) {
        try {
          chrome.runtime.sendMessage({ action: 'videoTick' }).catch(() => {});
        } catch {
          clearInterval(tickerId);
        }
      }
    }, 1000);
  })
  .catch(() => {});

function pauseAllMedia() {
  collectMedia('video, audio').forEach((m) => {
    try { m.pause(); } catch {}
  });
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
}

// Rest means rest: leave fullscreen (the overlay would render under a
// fullscreen element), stop all playback, keep it stopped, and - in the top
// frame - draw the blocking overlay.
function enterRest(restTimeSeconds) {
  if (restActive) return;
  restActive = true;

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  pauseAllMedia();
  const keepPaused = (e) => {
    if (e.target instanceof HTMLMediaElement) {
      try { e.target.pause(); } catch {}
    }
  };
  document.addEventListener('play', keepPaused, true);

  let overlay = null;
  const mountOverlay = () => {
    if (!restActive) return; // rest ended before the body was ready
    overlay = buildOverlay();
  };
  if (isTopFrame) {
    if (document.body) mountOverlay();
    else document.addEventListener('DOMContentLoaded', mountOverlay, { once: true });
  }

  setTimeout(() => {
    restActive = false;
    document.removeEventListener('play', keepPaused, true);
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
      document.body.style.pointerEvents = '';
      document.body.style.userSelect = '';
    }
  }, restTimeSeconds * 1000);
}

function buildOverlay() {
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
  overlay.style.flexDirection = 'column';
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
  return overlay;
}

}
