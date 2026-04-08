// options.js -- Settings page logic for Such Summary

// API keys are stored in chrome.storage.local (device-only, never synced)
const LOCAL_KEYS = ['claudeApiKey'];

// Everything else syncs across devices
const SYNC_KEYS = [
  'summaryType',
  'promptTldr', 'promptConcise', 'promptQuotes',
  'preferFastForLongArticles', 'disableLargeContentWarning', 'disableCostAlerts',
  'domainDefaults',
];

const DEFAULT_DOMAIN_DEFAULTS = { 'youtube.com': 'fast' };
const DOMAIN_TYPE_LABELS = { fast: 'Fast', high_fidelity: 'Best quality' };

let saveTimeout = null;
let lastSavedKeys = {};
let currentDomainDefaults = {};

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  Promise.all([
    new Promise(resolve => chrome.storage.sync.get(SYNC_KEYS, resolve)),
    new Promise(resolve => chrome.storage.local.get(LOCAL_KEYS, resolve)),
  ]).then(([syncItems, localItems]) => {
    const items = { ...syncItems, ...localItems };
    const summaryType = getDefaultSummaryType(items);

    const radio = document.querySelector(`input[name="summaryType"][value="${summaryType}"]`);
    if (radio) radio.checked = true;

    document.getElementById('claudeApiKey').value = items.claudeApiKey || '';
    lastSavedKeys = {
      claudeApiKey: items.claudeApiKey || '',
    };

    document.getElementById('promptTldr').value = items.promptTldr || DEFAULT_PROMPTS.tldr;
    document.getElementById('promptConcise').value = items.promptConcise || DEFAULT_PROMPTS.concise;
    document.getElementById('promptQuotes').value = items.promptQuotes || DEFAULT_PROMPTS.quotes;

    document.getElementById('preferFastForLongArticles').checked = shouldPreferFastForLongArticles(items.preferFastForLongArticles);
    document.getElementById('disableLargeContentWarning').checked = !!items.disableLargeContentWarning;
    document.getElementById('disableCostAlerts').checked = !!items.disableCostAlerts;

    currentDomainDefaults = {
      ...DEFAULT_DOMAIN_DEFAULTS,
      ...sanitizeDomainDefaults(items.domainDefaults),
    };

    updateAvailableModes();
    renderDomainDefaults();
    updateCostEstimates();

    const needsCleanup =
      (items.summaryType && !sanitizeSummaryType(items.summaryType)) ||
      typeof items.preferFastForLongArticles !== 'boolean' ||
      JSON.stringify(items.domainDefaults || {}) !== JSON.stringify(currentDomainDefaults);

    if (needsCleanup) {
      scheduleSave(0);
    }
  });

  document.querySelectorAll('input[name="summaryType"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      updateAvailableModes();
      scheduleSave();
    });
  });

  document.querySelectorAll('input[type="password"]').forEach((el) => {
    el.addEventListener('input', () => {
      updateAvailableModes();
      scheduleSave();
    });
  });

  document.querySelectorAll('textarea').forEach((el) => {
    el.addEventListener('input', () => scheduleSave(2000));
  });

  document.getElementById('preferFastForLongArticles').addEventListener('change', () => scheduleSave());
  document.getElementById('disableLargeContentWarning').addEventListener('change', () => scheduleSave());
  document.getElementById('disableCostAlerts').addEventListener('change', () => scheduleSave());

  document.querySelectorAll('.toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      btn.classList.toggle('showing', isHidden);
    });
  });

  document.querySelectorAll('.btn-reset[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.prompt;
      const type = id.replace('prompt', '').toLowerCase();
      document.getElementById(id).value = DEFAULT_PROMPTS[type] || '';
      scheduleSave();
    });
  });

  initLogs();
  initDomainDefaults();
});

// ---------------------------------------------------------------------------
// Enable/disable summary type options based on available API keys
// ---------------------------------------------------------------------------

function updateAvailableModes() {
  const hasClaudeKey = document.getElementById('claudeApiKey').value.trim().length > 0;
  const optionFast = document.getElementById('optionFast');
  const fastRadio = optionFast.querySelector('input[type="radio"]');
  const hfRadio = document.querySelector('input[name="summaryType"][value="high_fidelity"]');
  const hfLabel = hfRadio.closest('.summary-type-option');
  const noKeyMsg = document.getElementById('noKeyMessage');

  if (hasClaudeKey) {
    fastRadio.disabled = false;
    optionFast.classList.remove('disabled');
    hfRadio.disabled = false;
    hfLabel.classList.remove('disabled');
    noKeyMsg.style.display = 'none';
  } else {
    fastRadio.disabled = true;
    optionFast.classList.add('disabled');
    hfRadio.disabled = true;
    hfLabel.classList.add('disabled');
    noKeyMsg.style.display = '';
  }

  document.getElementById('anthropicKeyLink').style.display = hasClaudeKey ? 'none' : '';

  const selected = document.querySelector('input[name="summaryType"]:checked')?.value;
  if (!sanitizeSummaryType(selected)) {
    document.querySelector('input[name="summaryType"][value="fast"]').checked = true;
    scheduleSave();
  }
}

// ---------------------------------------------------------------------------
// Auto-save with debounce
// ---------------------------------------------------------------------------

function scheduleSave(delay = 400) {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(save, delay);
}

function save() {
  const summaryType = getDefaultSummaryType({
    summaryType: document.querySelector('input[name="summaryType"]:checked')?.value,
    claudeApiKey: document.getElementById('claudeApiKey').value.trim(),
  });

  const localData = {
    claudeApiKey: document.getElementById('claudeApiKey').value.trim(),
  };

  const syncData = {
    summaryType,
    promptTldr: document.getElementById('promptTldr').value,
    promptConcise: document.getElementById('promptConcise').value,
    promptQuotes: document.getElementById('promptQuotes').value,
    preferFastForLongArticles: document.getElementById('preferFastForLongArticles').checked,
    disableLargeContentWarning: document.getElementById('disableLargeContentWarning').checked,
    disableCostAlerts: document.getElementById('disableCostAlerts').checked,
    domainDefaults: currentDomainDefaults,
  };

  const anthropicChanged = localData.claudeApiKey !== lastSavedKeys.claudeApiKey;

  Promise.all([
    new Promise(resolve => chrome.storage.local.set(localData, resolve)),
    new Promise(resolve => chrome.storage.sync.set(syncData, resolve)),
  ]).then(() => {
    Object.assign(lastSavedKeys, localData);
    if (anthropicChanged) {
      showApiKeySaved('anthropicKeySaved');
    } else {
      showToast('Settings saved');
    }
  });
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
  }, 1500);
}

function showApiKeySaved(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.classList.add('visible');
  setTimeout(() => {
    el.classList.remove('visible');
  }, 2500);
}

// ---------------------------------------------------------------------------
// Usage logs
// ---------------------------------------------------------------------------

function initLogs() {
  const toggleLink = document.getElementById('toggleLogs');
  const logsSection = document.getElementById('logsSection');
  const clearBtn = document.getElementById('clearLogs');

  toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    const visible = logsSection.style.display !== 'none';
    if (visible) {
      logsSection.style.display = 'none';
      toggleLink.textContent = 'Show usage logs';
    } else {
      logsSection.style.display = 'block';
      toggleLink.textContent = 'Hide usage logs';
      loadLogs();
    }
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearUsageLogs' }, () => {
      loadLogs();
      showToast('Logs cleared');
    });
  });
}

async function loadLogs() {
  const pricing = await getCachedOrDefaultPricing();

  chrome.runtime.sendMessage({ action: 'getUsageLogs' }, (logs) => {
    const container = document.getElementById('logsContent');
    const totalCostEl = document.getElementById('logsTotalCost');

    if (!logs || logs.length === 0) {
      container.textContent = '';
      totalCostEl.style.display = 'none';
      const p = document.createElement('p');
      p.className = 'logs-empty';
      p.textContent = 'No usage data yet. Summarise an article to start logging.';
      container.appendChild(p);
      return;
    }

    const totalCost = estimateTotalCost(logs, pricing);
    totalCostEl.textContent = `Estimated 30-day total: ${formatCostUSD(totalCost)}`;
    totalCostEl.style.display = 'block';

    const byDate = {};
    for (const entry of logs) {
      const date = entry.date || entry.ts?.slice(0, 10) || 'Unknown';
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(entry);
    }

    const sortedDates = Object.keys(byDate).sort().reverse();
    container.textContent = '';

    for (const date of sortedDates) {
      const entries = byDate[date];
      const dayDiv = document.createElement('div');
      dayDiv.className = 'logs-day';

      let dayInput = 0;
      let dayOutput = 0;
      let dayCost = 0;
      for (const entry of entries) {
        dayInput += entry.inputTokens || 0;
        dayOutput += entry.outputTokens || 0;
        dayCost += estimateEntryCost(entry, pricing);
      }

      const header = document.createElement('div');
      header.className = 'logs-day-header';
      header.addEventListener('click', () => dayDiv.classList.toggle('expanded'));

      const dateSpan = document.createElement('span');
      const arrow = document.createElement('span');
      arrow.className = 'logs-day-arrow';
      arrow.textContent = '\u25B6';
      dateSpan.appendChild(arrow);
      dateSpan.appendChild(document.createTextNode(formatDate(date)));
      header.appendChild(dateSpan);

      const totalsSpan = document.createElement('span');
      totalsSpan.className = 'logs-day-totals';
      totalsSpan.textContent = `${dayInput.toLocaleString()} in / ${dayOutput.toLocaleString()} out \u00b7 ~${formatCostUSD(dayCost)}`;
      header.appendChild(totalsSpan);

      dayDiv.appendChild(header);

      const detail = document.createElement('div');
      detail.className = 'logs-day-detail';

      const table = document.createElement('table');
      table.className = 'logs-table';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const col of ['Article', 'Type', 'Model', 'In', 'Out', 'Cost']) {
        const th = document.createElement('th');
        th.textContent = col;
        if (col === 'In' || col === 'Out' || col === 'Cost') th.className = 'token-cell';
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      for (const entry of entries) {
        const row = document.createElement('tr');

        const urlCell = document.createElement('td');
        urlCell.className = 'url-cell';
        urlCell.title = entry.url || '';
        if (entry.url) {
          const link = document.createElement('a');
          link.href = entry.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = friendlyUrl(entry.url);
          urlCell.appendChild(link);
        } else {
          urlCell.textContent = '(unknown)';
        }
        row.appendChild(urlCell);

        const typeCell = document.createElement('td');
        typeCell.textContent = entry.type || '';
        row.appendChild(typeCell);

        const modelCell = document.createElement('td');
        modelCell.textContent = entry.model || '';
        row.appendChild(modelCell);

        const inCell = document.createElement('td');
        inCell.className = 'token-cell';
        inCell.textContent = (entry.inputTokens || 0).toLocaleString();
        row.appendChild(inCell);

        const outCell = document.createElement('td');
        outCell.className = 'token-cell';
        outCell.textContent = (entry.outputTokens || 0).toLocaleString();
        row.appendChild(outCell);

        const costCell = document.createElement('td');
        costCell.className = 'token-cell';
        costCell.textContent = formatCostUSD(estimateEntryCost(entry, pricing));
        row.appendChild(costCell);

        tbody.appendChild(row);
      }

      table.appendChild(tbody);
      detail.appendChild(table);
      dayDiv.appendChild(detail);
      container.appendChild(dayDiv);
    }
  });
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function friendlyUrl(url) {
  if (!url) return '(unknown)';
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname : '';
    const display = u.hostname.replace('www.', '') + path;
    return display.length > 50 ? display.slice(0, 47) + '...' : display;
  } catch {
    return url.slice(0, 50);
  }
}

// ---------------------------------------------------------------------------
// Cost estimates in API key section
// ---------------------------------------------------------------------------

async function updateCostEstimates() {
  const pricing = await getCachedOrDefaultPricing();

  chrome.runtime.sendMessage({ action: 'getUsageLogs' }, (logs) => {
    const summaryHintEl = document.getElementById('apiUsageSummaryEmpty');

    if (!logs || logs.length === 0) {
      summaryHintEl.textContent = 'Estimates appear after you summarise a few pages.';
      return;
    }

    let anthropicCost = 0;
    for (const entry of logs) {
      if (entry.provider === 'anthropic') {
        anthropicCost += estimateEntryCost(entry, pricing);
      }
    }

    summaryHintEl.textContent = anthropicCost > 0
      ? `Estimated spend last 30 days: ${formatCostUSD(anthropicCost)}`
      : 'No billable usage recorded in the last 30 days.';
  });
}

// ---------------------------------------------------------------------------
// Domain-specific defaults
// ---------------------------------------------------------------------------

function initDomainDefaults() {
  const addBtn = document.getElementById('addDomainBtn');
  const form = document.getElementById('domainDefaultsForm');
  const saveBtn = document.getElementById('domainSaveBtn');
  const cancelBtn = document.getElementById('domainCancelBtn');
  const domainInput = document.getElementById('domainInput');

  addBtn.addEventListener('click', () => {
    form.style.display = 'block';
    addBtn.style.display = 'none';
    form.dataset.editing = '';
    domainInput.value = '';
    document.getElementById('domainTypeSelect').value = 'fast';
    domainInput.focus();
  });

  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    addBtn.style.display = '';
    delete form.dataset.editing;
  });

  saveBtn.addEventListener('click', () => {
    const domain = domainInput.value
      .trim()
      .toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/.*$/, '');
    const type = sanitizeSummaryType(document.getElementById('domainTypeSelect').value);
    if (!domain || !type) return;

    const editingDomain = form.dataset.editing;
    if (editingDomain && editingDomain !== domain) {
      delete currentDomainDefaults[editingDomain];
    }

    currentDomainDefaults[domain] = type;
    renderDomainDefaults();
    form.style.display = 'none';
    addBtn.style.display = '';
    delete form.dataset.editing;
    scheduleSave();
  });

  domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
    if (e.key === 'Escape') cancelBtn.click();
  });

  renderDomainDefaults();
}

function renderDomainDefaults() {
  const list = document.getElementById('domainDefaultsList');
  const entries = Object.entries(currentDomainDefaults);
  list.textContent = '';

  if (entries.length === 0) return;

  for (const [domain, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = document.createElement('div');
    row.className = 'domain-rule';

    const label = document.createElement('span');
    label.className = 'domain-rule-label';
    label.textContent = `${domain} → ${DOMAIN_TYPE_LABELS[type] || type}`;
    row.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'domain-rule-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-domain-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      const form = document.getElementById('domainDefaultsForm');
      document.getElementById('domainInput').value = domain;
      document.getElementById('domainTypeSelect').value = type;
      form.dataset.editing = domain;
      form.style.display = 'block';
      document.getElementById('addDomainBtn').style.display = 'none';
      document.getElementById('domainInput').focus();
    });
    actions.appendChild(editBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-domain-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      delete currentDomainDefaults[domain];
      renderDomainDefaults();
      scheduleSave();
    });
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    list.appendChild(row);
  }
}
