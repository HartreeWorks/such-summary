importScripts('providers.js');

// ---------------------------------------------------------------------------
// Friendly error classification
// ---------------------------------------------------------------------------

function classifyApiError(rawMessage, provider) {
  const lower = rawMessage.toLowerCase();
  const providerName = { anthropic: 'Anthropic' }[provider] || provider;

  if (lower.includes('invalid x-api-key') || lower.includes('invalid api key') ||
      lower.includes('incorrect api key') || lower.includes('authentication') ||
      lower.includes('unauthorized') || lower.includes('api key not valid') ||
      /\b401\b/.test(lower)) {
    return {
      message: `Your ${providerName} API key appears to be invalid. Please check it in extension settings.`,
      showSettingsLink: true,
    };
  }

  if (lower.includes('rate limit') || lower.includes('too many requests') || /\b429\b/.test(lower)) {
    return {
      message: `${providerName} rate limit reached. Please wait a moment and try again.`,
      showSettingsLink: false,
    };
  }

  if (lower.includes('quota') || lower.includes('billing') || lower.includes('insufficient') ||
      lower.includes('exceeded') || lower.includes('credit')) {
    return {
      message: `Your ${providerName} account may have a billing or quota issue. Please check your account.`,
      showSettingsLink: false,
    };
  }

  if (lower.includes('forbidden') || lower.includes('permission') ||
      lower.includes('access denied') || /\b403\b/.test(lower)) {
    return {
      message: `Access denied by ${providerName}. If you're using a VPN, try disabling it — some API providers block VPN traffic.`,
      showSettingsLink: true,
    };
  }

  if (/\b5\d{2}\b/.test(lower) || lower.includes('server error') || lower.includes('internal error')) {
    return {
      message: `${providerName} is experiencing issues. Please try again in a few moments.`,
      showSettingsLink: false,
    };
  }

  if (lower.includes('failed to fetch') || lower.includes('networkerror') ||
      lower.includes('econnrefused') || lower.includes('err_connection')) {
    return {
      message: `Could not reach ${providerName} API — check your internet connection, or try disabling your VPN.`,
      showSettingsLink: false,
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return {
      message: `Request to ${providerName} timed out — please try again.`,
      showSettingsLink: false,
    };
  }

  return {
    message: rawMessage,
    showSettingsLink: false,
  };
}

// ---------------------------------------------------------------------------
// Auto-open welcome page on first install
// ---------------------------------------------------------------------------

chrome.runtime.setUninstallURL('https://wow.pjh.is/such-summary/uninstalled');

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
  // Refresh pricing cache on install/update
  getCachedOrDefaultPricing();
});

// ---------------------------------------------------------------------------
// Inject content scripts and send action
// ---------------------------------------------------------------------------

async function ensureContentScriptAndSummarise(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    chrome.tabs.sendMessage(tab.id, { action: 'summarize' });
  } catch {
    try {
      const isPdf = tab.url?.endsWith('.pdf') || tab.url?.includes('.pdf?');
      const files = isPdf
        ? ['lib/pdf.min.js', 'lib/readability.min.js', 'lib/marked.min.js', 'content-markdown.js', 'content-extractors.js', 'content.js']
        : ['lib/readability.min.js', 'lib/marked.min.js', 'content-markdown.js', 'content-extractors.js', 'content.js'];
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files,
      });
      chrome.tabs.sendMessage(tab.id, { action: 'summarize' });
    } catch (error) {
      console.error('Failed to inject content script:', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Extension icon click + keyboard shortcut handler
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  ensureContentScriptAndSummarise(tab);
});

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'setStorage') {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: 'unauthorized' });
      return true;
    }
    const allowedKeys = ['claudeApiKey', 'devMode', 'usageLogs',
      'summaryType', 'promptTldr', 'promptConcise', 'promptQuotes',
      'preferFastForLongArticles', 'disableCostAlerts', 'costAlertLastThreshold', 'domainDefaults',
      'disableLargeContentWarning', 'hideLongArticleFastNotice'];
    const data = {};
    for (const [key, value] of Object.entries(request.data)) {
      if (allowedKeys.includes(key)) data[key] = value;
    }
    if (Object.keys(data).length === 0) {
      sendResponse({ error: 'no valid keys' });
      return true;
    }
    const localFields = ['claudeApiKey', 'devMode', 'usageLogs', 'costAlertLastThreshold'];
    const localData = {};
    const syncData = {};
    for (const [key, value] of Object.entries(data)) {
      if (localFields.includes(key)) {
        localData[key] = value;
      } else {
        syncData[key] = value;
      }
    }
    const saves = [];
    if (Object.keys(localData).length) saves.push(new Promise((resolve, reject) => {
      chrome.storage.local.set(localData, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    }));
    if (Object.keys(syncData).length) saves.push(new Promise((resolve, reject) => {
      chrome.storage.sync.set(syncData, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    }));
    Promise.all(saves).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      console.error('Storage save failed:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // @dev-bridge-start
  // Dev bridge: read chrome.storage from page context
  if (request.action === 'devGetStorage') {
    chrome.storage.local.get(['devMode'], (items) => {
      if (!items.devMode) { sendResponse({ error: 'devMode off' }); return; }
      const areas = { local: chrome.storage.local, sync: chrome.storage.sync };
      const area = areas[request.area || 'local'];
      area.get(request.keys || null, (result) => {
        sendResponse({ data: result });
      });
    });
    return true;
  }

  // Dev bridge: trigger summarisation from page context (always injects content script)
  if (request.action === 'summarize' && sender.tab) {
    (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          files: ['lib/readability.min.js', 'lib/marked.min.js', 'content-markdown.js', 'content-extractors.js', 'content.js'],
        });
      } catch (e) {
        // May fail if already injected or page doesn't allow scripts
      }
      chrome.tabs.sendMessage(sender.tab.id, { action: 'summarize' });
      sendResponse({ success: true });
    })();
    return true;
  }
  // @dev-bridge-end

  if (request.action === 'getUsageLogs') {
    chrome.storage.local.get(['usageLogs'], (items) => {
      sendResponse(items.usageLogs || []);
    });
    return true;
  }

  if (request.action === 'clearUsageLogs') {
    chrome.storage.local.set({ usageLogs: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getLargeContentCostEstimate' && sender.tab) {
    (async () => {
      try {
        const settings = await getSettings();
        let summaryType = settings.summaryType;
        const wordCount = Math.max(0, request.wordCount || 0);

        const domainDefaults = settings.domainDefaults || { 'youtube.com': 'fast' };
        summaryType = getEffectiveSummaryType(summaryType, domainDefaults, sender.tab.url);

        if (settings.preferFastForLongArticles && wordCount > LONG_ARTICLE_FAST_MODEL_THRESHOLD) {
          summaryType = 'fast';
        }

        const pricing = await getCachedOrDefaultPricing();
        const fastEstimatedCost = formatCostUSD(
          estimateSummaryRunCostForMode(wordCount, 'fast', pricing)
        );
        const highFidelityEstimatedCost = formatCostUSD(
          estimateSummaryRunCostForMode(wordCount, 'high_fidelity', pricing)
        );
        const effectiveEstimatedCost = formatCostUSD(
          estimateSummaryRunCostForMode(wordCount, summaryType, pricing)
        );

        sendResponse({
          effectiveSummaryType: summaryType,
          effectiveSummaryLabel: SUMMARY_TYPE_LABELS[summaryType] || summaryType,
          effectiveEstimatedCost,
          fastEstimatedCost,
          highFidelityEstimatedCost,
        });
      } catch (error) {
        console.error('Failed to estimate large content cost:', error);
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'cycleSummaryType') {
    if (!sender.tab) { sendResponse({ error: 'not in tab context' }); return true; }
    handleCycleSummaryType(sender.tab).then(sendResponse);
    return true;
  }

  if (request.action === 'getYouTubeTranscript') {
    if (!sender.tab) { sendResponse({ error: 'not in tab context' }); return true; }
    (async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [request.videoId || null],
          func: async (expectedVideoId) => {
            try {
              // Verify the page is showing the expected video (guards against
              // stale transcript panel content after YouTube SPA navigation)
              if (expectedVideoId) {
                const currentVideoId = document.querySelector('ytd-watch-flexy')?.getAttribute('video-id')
                  || new URLSearchParams(window.location.search).get('v');
                if (currentVideoId && currentVideoId !== expectedVideoId) {
                  return { error: 'Video ID mismatch: page shows ' + currentVideoId + ' but expected ' + expectedVideoId };
                }
              }

              // Open the transcript panel
              const panel = document.querySelector(
                'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
              );
              if (!panel) return { error: 'No transcript panel found for this video.' };

              const wasHidden = panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
              if (wasHidden) {
                panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
              }

              // Wait for segments to appear (poll up to 10s)
              let segments = [];
              for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 250));
                segments = document.querySelectorAll('ytd-transcript-segment-renderer');
                if (segments.length > 0) break;
              }

              if (!segments.length) {
                if (wasHidden) panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
                return { error: 'Transcript panel opened but no segments loaded.' };
              }

              const texts = Array.from(segments).map(seg => {
                const el = seg.querySelector('.segment-text, yt-formatted-string');
                return el?.textContent?.trim() || '';
              }).filter(Boolean);

              // Close the panel if we opened it
              if (wasHidden) {
                panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
              }

              return { transcript: texts.join(' ') };
            } catch (e) {
              return { error: e.message };
            }
          },
        });
        sendResponse(results?.[0]?.result || { error: 'Script execution returned no result.' });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'getSummary') {
    if (!sender.tab) { sendResponse({ error: 'not in tab context' }); return true; }
    const requestedSummaryType = sanitizeSummaryType(request.requestedSummaryType);
    summariseArticle(request.article, sender.tab.id, sender.tab.url, {
      manualSummaryTypeOverride: !!request.manualSummaryTypeOverride || !!requestedSummaryType,
      requestedSummaryType,
    });
    return true;
  } else if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------------------
// Cycle summary type (fast → high_fidelity → fast)
// ---------------------------------------------------------------------------

const SUMMARY_TYPE_ORDER = ['fast', 'high_fidelity'];

async function handleCycleSummaryType(tab) {
  const syncItems = await new Promise(r => chrome.storage.sync.get(['summaryType'], r));
  const current = getDefaultSummaryType({
    summaryType: syncItems.summaryType,
  });
  const currentIndex = SUMMARY_TYPE_ORDER.indexOf(current);
  const nextIndex = (currentIndex + 1) % SUMMARY_TYPE_ORDER.length;
  const newType = SUMMARY_TYPE_ORDER[nextIndex];
  await new Promise(r => chrome.storage.sync.set({ summaryType: newType }, r));

  return { summaryType: newType, label: SUMMARY_TYPE_LABELS[newType] };
}

// ---------------------------------------------------------------------------
// Settings loader
// ---------------------------------------------------------------------------

async function getSettings() {
  const [syncItems, localItems] = await Promise.all([
    new Promise(r => chrome.storage.sync.get(
      ['summaryType', 'promptTldr', 'promptConcise', 'promptQuotes', 'preferFastForLongArticles', 'domainDefaults', 'hideLongArticleFastNotice'],
      r
    )),
    new Promise(r => chrome.storage.local.get(
      ['claudeApiKey'],
      r
    )),
  ]);
  const domainDefaults = sanitizeDomainDefaults(syncItems.domainDefaults || { 'youtube.com': 'fast' });
  return {
    ...syncItems,
    ...localItems,
    summaryType: getDefaultSummaryType({ summaryType: syncItems.summaryType, claudeApiKey: localItems.claudeApiKey }),
    preferFastForLongArticles: shouldPreferFastForLongArticles(syncItems.preferFastForLongArticles),
    domainDefaults,
  };
}

// ---------------------------------------------------------------------------
// Usage logging
// ---------------------------------------------------------------------------

const USAGE_LOG_MAX_AGE_DAYS = 30;

function createUsageEntry({ url, model, summaryType, inputTokens, outputTokens, provider }) {
  const now = new Date();
  return {
    ts: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    url: url || '',
    model: model || '',
    type: summaryType,
    provider: provider || '',
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
  };
}

let _usageWriteQueue = Promise.resolve();

async function flushUsageEntries(entries) {
  if (!entries.length) return;
  _usageWriteQueue = _usageWriteQueue.then(async () => {
    const items = await new Promise(r => chrome.storage.local.get(['usageLogs'], r));
    const logs = items.usageLogs || [];
    logs.push(...entries);

    const cutoff = Date.now() - (USAGE_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const pruned = logs.filter(e => new Date(e.ts).getTime() > cutoff);

    await new Promise(r => chrome.storage.local.set({ usageLogs: pruned }, r));
  }).catch(err => console.error('flushUsageEntries failed:', err));
  return _usageWriteQueue;
}

// ---------------------------------------------------------------------------
// Summarise article (progressive, parallel requests)
// ---------------------------------------------------------------------------

function getEffectiveSummaryType(summaryType, domainDefaults, tabUrl) {
  if (!tabUrl) return summaryType;
  try {
    const hostname = new URL(tabUrl).hostname.replace(/^www\./, '');
    for (const [domain, type] of Object.entries(domainDefaults)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return type;
      }
    }
  } catch { /* invalid URL, use global default */ }
  return summaryType;
}

const tabsInFlight = new Map(); // tabId → { url, abortController }

async function summariseArticle(article, tabId, tabUrl, options = {}) {
  const existing = tabsInFlight.get(tabId);
  if (existing && existing.url === tabUrl) {
    existing.abortController.abort();
  }
  const abortController = new AbortController();
  tabsInFlight.set(tabId, { url: tabUrl, abortController });
  try {
    const {
      manualSummaryTypeOverride = false,
      requestedSummaryType = null,
    } = options;
    const settings = await getSettings();
    let summaryType = requestedSummaryType || settings.summaryType;
    const wordCount = article.wordCount || 0;

    // Check for domain-specific override
    const domainDefaults = settings.domainDefaults || { 'youtube.com': 'fast' };
    if (!requestedSummaryType) {
      summaryType = getEffectiveSummaryType(summaryType, domainDefaults, tabUrl);
    }

    const longArticleFastOverride =
      !manualSummaryTypeOverride &&
      summaryType !== 'fast' &&
      settings.preferFastForLongArticles &&
      wordCount > LONG_ARTICLE_FAST_MODEL_THRESHOLD;
    const showLongArticleFastNotice = longArticleFastOverride && !settings.hideLongArticleFastNotice;

    let longArticleOriginalEstimatedCost = null;
    let longArticleFastEstimatedCost = null;

    if (longArticleFastOverride) {
      if (showLongArticleFastNotice) {
        const pricing = await getCachedOrDefaultPricing();
        longArticleOriginalEstimatedCost = formatCostUSD(
          estimateSummaryRunCostForMode(wordCount, summaryType, pricing)
        );
        longArticleFastEstimatedCost = formatCostUSD(
          estimateSummaryRunCostForMode(wordCount, 'fast', pricing)
        );
      }
      summaryType = 'fast';
    }

    const preset = MODE_PRESETS[summaryType];

    // Check we have at least one usable API key
    if (!settings.claudeApiKey) {
      chrome.tabs.sendMessage(tabId, { action: 'noApiKey' });
      return;
    }

    // Send initial loading state with current summary type
    const sectionModels = {
      tldr: preset.tldr.model,
      concise: preset.concise.model,
      quotes: preset.quotes.model,
    };
    chrome.tabs.sendMessage(tabId, {
      action: 'showProgressiveLoading',
      summaryType,
      sectionModels,
      longArticleFastOverride: showLongArticleFastNotice,
      longArticleWordCount: wordCount,
      longArticleOriginalEstimatedCost,
      longArticleFastEstimatedCost,
    });

    // Fire three parallel requests, collect usage entries for a single batched write
    const summaryTypes = [
      { type: 'tldr', customPrompt: settings.promptTldr },
      { type: 'concise', customPrompt: settings.promptConcise },
      { type: 'quotes', customPrompt: settings.promptQuotes },
    ];

    const usageEntries = [];

    await Promise.all(summaryTypes.map(async ({ type, customPrompt }) => {
      const { provider, model } = preset[type];
      const apiKey = settings.claudeApiKey;

      try {
        const result = await summarise(provider, apiKey, model, type, article, customPrompt || null, abortController.signal);

        usageEntries.push(createUsageEntry({
          url: tabUrl,
          model: result.model,
          summaryType: type,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          provider,
        }));

        chrome.tabs.sendMessage(tabId, {
          action: 'showProgressiveSummary',
          type,
          summary: result.summary,
          model: result.model,
          timeMs: result.timeMs,
          sourceUrl: tabUrl,
          truncated: result.truncated,
          truncatedWordCount: result.truncatedWordCount,
          originalWordCount: result.originalWordCount,
        });
      } catch (error) {
        if (error.name === 'AbortError') return;
        console.error(`Error during ${type} summarisation (${provider}/${model}):`, error);
        const rawMsg = error.message || 'Unknown error';
        const prefix = error instanceof TypeError ? `fetch failed: ${rawMsg}` : rawMsg;
        const safeMessage = prefix
          .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
        const friendly = classifyApiError(safeMessage, provider);
        chrome.tabs.sendMessage(tabId, {
          action: 'showProgressiveSummary',
          type,
          summary: `Error: ${friendly.message}`,
          showSettingsLink: friendly.showSettingsLink,
          sourceUrl: tabUrl,
        });
      }
    }));

    await flushUsageEntries(usageEntries);
    await checkCostThreshold(tabId);
  } finally {
    // Only clear if this is still the active summarisation for the tab
    const current = tabsInFlight.get(tabId);
    if (current && current.abortController === abortController) {
      tabsInFlight.delete(tabId);
    }
  }
}

// ---------------------------------------------------------------------------
// Cost threshold alerts
// ---------------------------------------------------------------------------

async function checkCostThreshold(tabId) {
  const [syncItems, localItems] = await Promise.all([
    new Promise(r => chrome.storage.sync.get(['disableCostAlerts'], r)),
    new Promise(r => chrome.storage.local.get(['usageLogs', 'costAlertLastThreshold'], r)),
  ]);

  if (syncItems.disableCostAlerts) return;

  const logs = localItems.usageLogs || [];
  if (!logs.length) return;

  const pricing = await getCachedOrDefaultPricing();
  const totalCost = estimateTotalCost(logs, pricing);
  const crossed = highestCrossedThreshold(totalCost);
  const lastAlerted = localItems.costAlertLastThreshold || 0;

  // Reset if spend dropped below previously alerted threshold
  if (crossed < lastAlerted) {
    await new Promise(r => chrome.storage.local.set({ costAlertLastThreshold: crossed }, r));
    return;
  }

  if (crossed > 0 && crossed > lastAlerted) {
    await new Promise(r => chrome.storage.local.set({ costAlertLastThreshold: crossed }, r));
    try {
      chrome.tabs.sendMessage(tabId, {
        action: 'showCostAlert',
        amount: totalCost,
        threshold: crossed,
      });
    } catch {
      // Tab may have closed
    }
  }
}
