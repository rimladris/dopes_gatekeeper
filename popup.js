// popup.js
//
// Storage writes are batched in the background worker, so storage is stale by
// up to 15s. Poll getStatus instead: it reads the worker's live in-memory
// counters, and the polling itself keeps the worker awake while the popup is
// open.

function formatCountdown(seconds) {
  const total = Math.max(Math.ceil(Number(seconds) || 0), 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const countdownEl = document.getElementById('countdown');
  const statusLabelEl = document.getElementById('status-label');
  const resetBtn = document.getElementById('reset');

  function render(status) {
    const { timeSpent = 0, allowance = 0, restRemainingMs = 0 } = status;

    countdownEl.classList.remove('warn', 'danger');

    if (restRemainingMs > 0) {
      countdownEl.textContent = formatCountdown(restRemainingMs / 1000);
      countdownEl.classList.add('danger');
      statusLabelEl.textContent = 'resting - dopes has the wheel';
      return;
    }

    countdownEl.textContent = formatCountdown(allowance - timeSpent);
    if (allowance > 0) {
      const ratio = timeSpent / allowance;
      if (ratio >= 0.9) countdownEl.classList.add('danger');
      else if (ratio >= 0.7) countdownEl.classList.add('warn');
    }
    statusLabelEl.textContent = 'time left before rest';
  }

  function poll() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (response) render(response);
    });
  }

  poll();
  const pollId = setInterval(poll, 500);
  window.addEventListener('unload', () => clearInterval(pollId));

  resetBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'resetTimer' }, poll);
  });

  document.getElementById('settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
