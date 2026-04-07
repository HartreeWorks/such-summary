// ---------------------------------------------------------------------------
// Welcome page logic
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Show correct keyboard shortcut for platform
  const isMac = navigator.platform.toUpperCase().includes('MAC') ||
    navigator.userAgent.includes('Macintosh');
  if (isMac) {
    document.querySelectorAll('.shortcut-keys-mac').forEach(el => el.style.display = '');
    document.querySelectorAll('.shortcut-keys-other').forEach(el => el.style.display = 'none');
  }

  const keyInputs = {
    claudeApiKey: document.getElementById('claudeApiKey'),
  };
  const keyStatus = document.getElementById('keyStatus');
  const lockableSteps = document.querySelectorAll('#step2, #step3');
  const summaryTypeInputs = document.querySelectorAll('input[name="summaryType"]');

  // ---------------------------------------------------------------------------
  // Unlock/lock steps based on API key presence
  // ---------------------------------------------------------------------------

  function updateLockedState() {
    const hasAnyKey = keyInputs.claudeApiKey.value.trim().length > 0;

    lockableSteps.forEach(el => {
      if (hasAnyKey) {
        el.classList.remove('step-locked');
      } else {
        el.classList.add('step-locked');
      }
    });

    // Show key status if any key present
    keyStatus.style.display = hasAnyKey ? 'flex' : 'none';

    // Green tint on step 1 when key is saved
    const step1 = document.getElementById('step1');
    if (hasAnyKey) {
      step1.classList.add('step-complete');
    } else {
      step1.classList.remove('step-complete');
    }
  }

  // ---------------------------------------------------------------------------
  // Load existing keys
  // ---------------------------------------------------------------------------

  Promise.all([
    new Promise(resolve => chrome.storage.local.get(['claudeApiKey'], resolve)),
    new Promise(resolve => chrome.storage.sync.get(['summaryType'], resolve)),
  ]).then(([localItems, syncItems]) => {
    if (localItems.claudeApiKey) keyInputs.claudeApiKey.value = localItems.claudeApiKey;

    const summaryType = sanitizeSummaryType(syncItems.summaryType) || 'high_fidelity';
    const selectedInput = document.querySelector(`input[name="summaryType"][value="${summaryType}"]`);
    if (selectedInput) selectedInput.checked = true;
    if (!syncItems.summaryType) {
      chrome.storage.sync.set({ summaryType });
    }

    updateLockedState();
  });

  // ---------------------------------------------------------------------------
  // API key input — save on change with debounce
  // ---------------------------------------------------------------------------

  let saveTimeout;
  Object.entries(keyInputs).forEach(([storageKey, input]) => {
    input.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        const value = input.value.trim();
        if (value) {
          chrome.storage.local.set({ [storageKey]: value });
        } else {
          chrome.storage.local.remove(storageKey);
        }
        updateLockedState();
      }, 400);
    });
  });

  summaryTypeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      chrome.storage.sync.set({ summaryType: input.value });
    });
  });

  // ---------------------------------------------------------------------------
  // Shortcuts link — can't open chrome:// URLs directly
  // ---------------------------------------------------------------------------

  const shortcutsLink = document.getElementById('shortcutsLink');
  shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    navigator.clipboard.writeText('chrome://extensions/shortcuts').then(() => {
      shortcutsLink.textContent = 'Copied! Paste into your address bar';
      setTimeout(() => {
        shortcutsLink.textContent = 'chrome://extensions/shortcuts';
      }, 3000);
    });
  });

  // Try it button — open a sample article
  document.getElementById('tryItBtn').addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://www.cold-takes.com/all-possible-views-about-humanitys-future-are-wild/',
    });
  });

  // "Check settings" link in step 2
  document.getElementById('checkSettingsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Settings link
  document.getElementById('openSettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
