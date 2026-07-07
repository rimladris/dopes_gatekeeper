// popup.js

function formatCountdown(seconds) {
  const total = Math.max(Math.ceil(seconds), 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const countdownEl = document.getElementById('countdown');
  const statusLabelEl = document.getElementById('status-label');
  const resetBtn = document.getElementById('reset');

  let allowance = 0;
  let timeSpent = 0;
  let restUntil = 0;

  function render() {
    const remainingMs = restUntil - Date.now();
    const isResting = remainingMs > 0;

    countdownEl.classList.remove('warn', 'danger');

    if (isResting) {
      countdownEl.textContent = formatCountdown(remainingMs / 1000);
      countdownEl.classList.add('danger');
      statusLabelEl.textContent = 'resting - dopes has the wheel';
      return;
    }

    const remaining = allowance - timeSpent;
    countdownEl.textContent = formatCountdown(remaining);
    if (allowance > 0) {
      const ratio = timeSpent / allowance;
      if (ratio >= 0.9) countdownEl.classList.add('danger');
      else if (ratio >= 0.7) countdownEl.classList.add('warn');
    }
    statusLabelEl.textContent = 'time left before rest';
  }

  function fetchConfig() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      allowance = (response && response.allowance) || 0;
      render();
    });
  }

  fetchConfig();

  chrome.storage.local.get(['timeSpent', 'restUntil'], (result) => {
    timeSpent = result.timeSpent || 0;
    restUntil = result.restUntil || 0;
    render();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.timeSpent) timeSpent = changes.timeSpent.newValue || 0;
    if (changes.restUntil) restUntil = changes.restUntil.newValue || 0;
    if (changes.mode) fetchConfig();
    if (changes.timeSpent || changes.restUntil) render();
  });

  const tickId = setInterval(render, 250);
  window.addEventListener('unload', () => clearInterval(tickId));

  resetBtn.addEventListener('click', () => {
    chrome.storage.local.set({ timeSpent: 0 });
  });
});
