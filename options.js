// options.js

document.addEventListener('DOMContentLoaded', () => {
  const radios = document.querySelectorAll('input[name="mode"]');
  const options = {
    standard: document.getElementById('option-standard'),
    extended: document.getElementById('option-extended'),
    custom: document.getElementById('option-custom')
  };
  const allowanceInput = document.getElementById('custom-allowance');
  const restInput = document.getElementById('custom-rest');

  function applySelection(mode) {
    for (const radio of radios) {
      radio.checked = radio.value === mode;
    }
    for (const key of Object.keys(options)) {
      options[key].classList.toggle('selected', key === mode);
    }
  }

  // Same bounds the background enforces: 1 minute to 24 hours
  function clampMinutes(v, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 1440) : fallback;
  }

  chrome.storage.local.get(['mode', 'customAllowanceMin', 'customRestMin'], (result) => {
    const mode = result.mode === 'extended' || result.mode === 'custom' ? result.mode : 'standard';
    allowanceInput.value = clampMinutes(result.customAllowanceMin, 30);
    restInput.value = clampMinutes(result.customRestMin, 10);
    applySelection(mode);
  });

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ mode: radio.value });
      applySelection(radio.value);
    });
  }

  // Editing the numbers saves them and switches to custom mode
  function saveCustom() {
    const customAllowanceMin = clampMinutes(allowanceInput.value, 30);
    const customRestMin = clampMinutes(restInput.value, 10);
    allowanceInput.value = customAllowanceMin;
    restInput.value = customRestMin;
    chrome.storage.local.set({ customAllowanceMin, customRestMin, mode: 'custom' });
    applySelection('custom');
  }
  allowanceInput.addEventListener('change', saveCustom);
  restInput.addEventListener('change', saveCustom);
});
