// options.js

document.addEventListener('DOMContentLoaded', () => {
  const radios = document.querySelectorAll('input[name="mode"]');
  const options = {
    standard: document.getElementById('option-standard'),
    extended: document.getElementById('option-extended')
  };

  function applySelection(mode) {
    for (const radio of radios) {
      radio.checked = radio.value === mode;
    }
    for (const key of Object.keys(options)) {
      options[key].classList.toggle('selected', key === mode);
    }
  }

  chrome.storage.local.get(['mode'], (result) => {
    applySelection(result.mode === 'extended' ? 'extended' : 'standard');
  });

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ mode: radio.value });
      applySelection(radio.value);
    });
  }
});
