// Main UI controller for the summariser modal.
// Depends on content-markdown.js and content-extractors.js being loaded first.
(function() {
  const INSTANCE_KEY = '__ARTICLE_SUMMARIZER_INITIALIZED__';

  if (window[INSTANCE_KEY]) {
    return;
  }
  window[INSTANCE_KEY] = true;

  // Destructure utilities from companion scripts
  const {
    escapeHtml, processNestedBullets, escapeLiteralTildes,
    processTablesManually, htmlToMarkdown,
  } = window.SummarizerMarkdown;

  const {
    calculateWordStats, extractArticle: extractArticleFromPage, getDomainName, extractYouTubeTranscript,
  } = window.SummarizerExtractors;

  const VALID_SECTION_TYPES = ['tldr', 'concise', 'quotes'];
  const TEST_SIMULATE_WORD_COUNT_PARAM = 'such_summary_test__simulate_word_count';
  const SUMMARY_CACHE_SETTING_KEYS = new Set([
    'summaryType',
    'promptTldr',
    'promptConcise',
    'promptQuotes',
    'preferFastForLongArticles',
    'domainDefaults',
    'claudeApiKey',
  ]);

  function safeSendMessage(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // Strip raw HTML from AI-generated markdown to prevent XSS via prompt injection.
  marked.use({ renderer: { html: () => '' } });

  const BLOCKED_HREF_SCHEMES = /^\s*(javascript|data|vbscript):/i;

  function sanitiseHrefsDOM(container) {
    for (const a of container.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (href && BLOCKED_HREF_SCHEMES.test(href)) {
        a.setAttribute('href', 'about:blank');
        a.setAttribute('data-blocked', 'true');
      }
    }
  }

  function renderMarkdown(markdownText) {
    const formatted = processNestedBullets(markdownText);
    const safe = escapeLiteralTildes(formatted);

    let html = marked.parse(safe, {
      gfm: true, breaks: true, smartLists: true, tables: true
    });

    // Fallback if marked didn't process tables
    if (!html.includes('<table') && safe.includes('|')) {
      const manuallyProcessed = processTablesManually(safe);
      html = marked.parse(manuallyProcessed, {
        gfm: true, breaks: true, smartLists: true
      });
    }
    return html;
  }

  class ArticleSummarizer {
    constructor() {
      this.modal = null;
      this.shadowRoot = null;
      this.currentArticle = null;
      this.currentSummaryType = null;
      this.loadingSectionModels = {};
      this.loadingSectionStartTimes = {};
      this.loadingTimerId = null;
      this.cachedUrl = null;
      this.initializeModal();
    }

    initializeModal() {
      const container = document.createElement('div');
      container.id = 'ph-summarizer-container';
      document.body.appendChild(container);
      this.shadowRoot = container.attachShadow({ mode: 'closed' });

      const isYouTube = window.location.hostname === 'www.youtube.com' || window.location.hostname === 'youtube.com';

      // NOTE: The modal template uses innerHTML assignment on a closed shadow root.
      // This is intentional — the template is static HTML with no user-supplied content.
      // Dynamic content is always inserted via textContent or escapeHtml() later.
      const modalHTML = `
        <div class="ph-summarizer-modal-backdrop" data-visible="false">
          <button class="ph-summarizer-modal-close" aria-label="Close">\u00d7</button>
          <div class="ph-summarizer-modal">
            <div class="ph-summarizer-modal-body">
              <div class="ph-summarizer-article-header" style="display: none;">
                <div class="article-header-text">
                  <div class="article-title"></div>
                  <div class="article-meta">
                    <span class="article-author"></span>
                    <span class="article-word-count" style="display: none;"></span>
                  </div>
                </div>
                <div class="ph-summarizer-header-right">
                  <div class="ph-summarizer-chat-links">
                  <button class="ph-summarizer-save-btn" aria-label="Save summary" title="Save as Markdown">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                  </button>
                  <button class="ph-summarizer-copy-all-btn" aria-label="Copy summary" title="Copy full summary">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                    </svg>
                  </button>
                  <button class="ph-summarizer-settings-btn" aria-label="Settings" title="Extension settings">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                  </button>
                  </div>
                </div>
              </div>
              <div class="ph-summarizer-loading-spinner">
                <div class="loading-text">Summarizing article...</div>
                <div class="loading-subtext">Using <span class="api-provider">AI</span> to create progressive summaries</div>
                <div class="spinner">
                  <div class="spinner-ring"></div>
                </div>
              </div>
              <div class="ph-summarizer-progressive-content" style="display: none;">
                <div class="ph-summarizer-summary-section tldr-section">
                  <div class="summary-section-header">
                    <h3 class="summary-section-title">TL;DR</h3>
                    <div class="summary-section-meta">
                      <span class="model-info" style="display: none;"></span>
                      <button class="ph-summarizer-section-copy" data-section="tldr" aria-label="Copy TL;DR Summary" title="Copy TL;DR summary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div class="summary-section-content loading"><div class="section-spinner"><div class="spinner-ring-small"></div></div></div>
                </div>
                <div class="ph-summarizer-summary-section concise-section">
                  <div class="summary-section-header">
                    <h3 class="summary-section-title">Summary</h3>
                    <div class="summary-section-meta">
                      <span class="model-info" style="display: none;"></span>
                      <button class="ph-summarizer-section-copy" data-section="concise" aria-label="Copy Concise Summary" title="Copy concise summary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div class="summary-section-content loading"><div class="section-spinner"><div class="spinner-ring-small"></div></div></div>
                </div>
                <div class="ph-summarizer-summary-section quotes-section">
                  <div class="summary-section-header">
                    <h3 class="summary-section-title">Key quotes</h3>
                    <div class="summary-section-meta">
                      <span class="model-info" style="display: none;"></span>
                      <button class="ph-summarizer-section-copy" data-section="quotes" aria-label="Copy Key Quotes" title="Copy key quotes">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div class="summary-section-content loading"><div class="section-spinner"><div class="spinner-ring-small"></div></div></div>
                </div>
              </div>
              <div class="ph-summarizer-summary-content" style="display: none;"></div>
              <div class="ph-summarizer-footer">
                <div class="footer-status-row">
                  <div class="footer-status-left">
                    <div class="footer-feedback-line">Feedback? <a class="feedback-link" href="mailto:wow@pjh.is">Email wow@pjh.is</a></div>
                  </div>
                  <div class="footer-status-right"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ph-summarizer-gdocs-modal" data-visible="false">
          <h3 class="ph-summarizer-gdocs-title">Paste Google Doc text to summarise</h3>
          <textarea class="ph-summarizer-gdocs-textarea" placeholder="1. Select the text in your document (Cmd+A)\n2. Copy it (Cmd+C)\n3. Paste it here (Cmd+V)\n\n(Sorry, Google Doc text can\u2019t be read directly...)"></textarea>
        </div>
      `;

      this.shadowRoot.innerHTML = modalHTML; // static template only — see NOTE above

      const styleSheet = document.createElement('link');
      styleSheet.rel = 'stylesheet';
      styleSheet.href = chrome.runtime.getURL('styles/modal.css');
      this.shadowRoot.insertBefore(styleSheet, this.shadowRoot.firstChild);

      this.modal = this.shadowRoot.querySelector('.ph-summarizer-modal-backdrop');
      this.shortcutKey = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '\u2325S' : 'Alt+S';

      // Event listeners
      this.shadowRoot.querySelector('.ph-summarizer-modal-close').addEventListener('click', () => this.hideModal());

      const saveButton = this.shadowRoot.querySelector('.ph-summarizer-save-btn');
      if (saveButton) saveButton.addEventListener('click', () => this.saveSummary());

      const copyAllButton = this.shadowRoot.querySelector('.ph-summarizer-copy-all-btn');
      if (copyAllButton) copyAllButton.addEventListener('click', () => this.copyFullSummary());

      const settingsButton = this.shadowRoot.querySelector('.ph-summarizer-settings-btn');
      if (settingsButton) settingsButton.addEventListener('click', () => safeSendMessage({ action: 'openOptions' }));

      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.hideModal();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.modal.getAttribute('data-visible') === 'true') {
          this.hideModal();
        }
        if (e.code === 'KeyS' && e.altKey && !e.shiftKey && this.modal.getAttribute('data-visible') === 'true') {
          e.preventDefault();
          this.cycleSummaryType();
        }
      });

      const gdocsTextarea = this.shadowRoot.querySelector('.ph-summarizer-gdocs-textarea');
      gdocsTextarea.addEventListener('paste', () => {
        setTimeout(() => {
          if (gdocsTextarea.value.trim().length > 0) {
            this.handleGoogleDocsContent(gdocsTextarea.value);
          }
        }, 0);
      });

      this.shadowRoot.querySelectorAll('.ph-summarizer-section-copy').forEach(button => {
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          this.copySectionContent(button.getAttribute('data-section'));
        });
      });
    }

    // --- Article extraction (delegates to content-extractors.js) ---

    async extractArticle() {
      const article = this._applyTestWordCountOverride(extractArticleFromPage());
      this.currentArticle = article;
      return article;
    }

    _getSimulatedWordCountOverride() {
      try {
        const raw = new URL(window.location.href).searchParams.get(TEST_SIMULATE_WORD_COUNT_PARAM);
        if (!raw) return null;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      } catch {
        return null;
      }
    }

    _applyTestWordCountOverride(article) {
      const simulatedWordCount = this._getSimulatedWordCountOverride();
      if (!article || !simulatedWordCount) return article;
      return {
        ...article,
        wordCount: simulatedWordCount,
        readingTimeMinutes: Math.max(1, Math.round(simulatedWordCount / 225)),
      };
    }

    // --- Modal display ---

    _updateArticleHeader(articleInfo) {
      const articleHeader = this.shadowRoot.querySelector('.ph-summarizer-article-header');
      const articleTitle = this.shadowRoot.querySelector('.article-title');
      const articleAuthor = this.shadowRoot.querySelector('.article-author');
      const articleWordCount = this.shadowRoot.querySelector('.article-word-count');
      const info = articleInfo || this.currentArticle;

      if (info && info.title) {
        if (articleTitle) articleTitle.textContent = info.title;
        if (articleAuthor) articleAuthor.textContent = info.author || '';
        if (articleWordCount) {
          if (info.wordCount) {
            articleWordCount.textContent = info.author ? `· ${info.wordCount.toLocaleString()} words` : `${info.wordCount.toLocaleString()} words`;
            articleWordCount.style.display = 'inline';
          } else {
            articleWordCount.textContent = '';
            articleWordCount.style.display = 'none';
          }
        }
        if (articleHeader) articleHeader.style.display = 'flex';
      } else {
        if (articleHeader) articleHeader.style.display = 'none';
      }
    }

    _setErrorContent(container, message) {
      // Build error UI with safe DOM methods
      const wrapper = document.createElement('div');
      wrapper.className = 'ph-summarizer-error';
      const icon = document.createElement('div');
      icon.className = 'error-icon';
      icon.textContent = '\u26a0\ufe0f';
      const msgDiv = document.createElement('div');
      msgDiv.className = 'error-message';
      const h3 = document.createElement('h3');
      h3.textContent = 'Something went wrong';
      const p = document.createElement('p');
      p.textContent = message;
      msgDiv.appendChild(h3);
      msgDiv.appendChild(p);
      wrapper.appendChild(icon);
      wrapper.appendChild(msgDiv);
      container.textContent = '';
      container.appendChild(wrapper);
    }

    showErrorMessage(message) {
      try {
        const summaryContent = this.shadowRoot.querySelector('.ph-summarizer-summary-content');
        const loadingSpinner = this.shadowRoot.querySelector('.ph-summarizer-loading-spinner');

        if (summaryContent && loadingSpinner) {
          this._setErrorContent(summaryContent, message);
          loadingSpinner.style.display = 'none';
          summaryContent.style.display = 'block';
        }
      } catch (error) {
        console.error('Failed to show error message:', error);
      }
    }

    showCostAlert(amount, threshold) {
      try {
        // Remove any existing cost alert
        const existing = this.shadowRoot.querySelector('.ph-summarizer-cost-alert');
        if (existing) existing.remove();

        const modalBody = this.shadowRoot.querySelector('.ph-summarizer-modal-body');
        if (!modalBody) return;

        const banner = document.createElement('div');
        banner.className = 'ph-summarizer-cost-alert';

        const icon = document.createElement('span');
        icon.className = 'cost-alert-icon';
        icon.textContent = '\u26a0\ufe0f';
        banner.appendChild(icon);

        const text = document.createElement('span');
        text.className = 'cost-alert-text';
        const formatted = amount < 0.01 ? '$' + amount.toFixed(4) : '$' + amount.toFixed(2);
        text.textContent = `Estimated API spend in the last 30 days: ${formatted}. Verify actual usage in your provider console and consider setting a spend limit.`;
        banner.appendChild(text);

        const dismiss = document.createElement('button');
        dismiss.className = 'cost-alert-dismiss';
        dismiss.textContent = '\u00d7';
        dismiss.addEventListener('click', () => banner.remove());
        banner.appendChild(dismiss);

        modalBody.insertBefore(banner, modalBody.firstChild);
      } catch (error) {
        console.error('Failed to show cost alert:', error);
      }
    }

    clearLongArticleFastNotice() {
      const existing = this.shadowRoot.querySelector('.ph-summarizer-model-switch-notice');
      if (existing) existing.remove();
    }

    async dismissLongArticleFastNotice() {
      try {
        await new Promise((resolve, reject) => {
          chrome.storage.sync.set({ hideLongArticleFastNotice: true }, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
          });
        });
      } catch (error) {
        console.error('Failed to persist long article notice dismissal:', error);
      } finally {
        this.clearLongArticleFastNotice();
      }
    }

    showLongArticleFastNotice(wordCount, originalEstimatedCost, fastEstimatedCost) {
      try {
        this.clearLongArticleFastNotice();

        const modalBody = this.shadowRoot.querySelector('.ph-summarizer-modal-body');
        if (!modalBody) return;
        const progressiveContent = this.shadowRoot.querySelector('.ph-summarizer-progressive-content');

        const banner = document.createElement('div');
        banner.className = 'ph-summarizer-model-switch-notice';

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'model-switch-notice-dismiss';
        dismiss.setAttribute('aria-label', 'Hide this notice permanently');
        dismiss.textContent = '\u00D7';
        dismiss.addEventListener('click', () => {
          this.dismissLongArticleFastNotice();
        });
        banner.appendChild(dismiss);

        const text = document.createElement('span');
        text.className = 'model-switch-notice-text';
        const formattedWordCount = (wordCount || 0).toLocaleString();
        const slowCost = originalEstimatedCost || '$0.00';
        const fastCost = fastEstimatedCost || '$0.00';

        const lead = document.createElement('strong');
        lead.textContent = `Long article (${formattedWordCount} words)!`;
        text.appendChild(lead);
        text.appendChild(document.createTextNode(
          ` Creating a fast summary to reduce API cost from ~${slowCost} to ~${fastCost}. `
        ));
        text.appendChild(document.createElement('br'));
        text.appendChild(document.createElement('br'));

        const cta = document.createElement('strong');
        cta.textContent = `Want a best quality summary? Press ${this.shortcutKey}.`;
        text.appendChild(cta);
        text.appendChild(document.createTextNode(
          ' You can disable the "use fast models for >10,000-word articles" feature in the '
        ));

        const settingsLink = document.createElement('a');
        settingsLink.href = '#';
        settingsLink.textContent = 'settings';
        settingsLink.addEventListener('click', (e) => {
          e.preventDefault();
          safeSendMessage({ action: 'openOptions' });
        });
        text.appendChild(settingsLink);
        text.appendChild(document.createTextNode('.'));

        banner.appendChild(text);

        if (progressiveContent) {
          modalBody.insertBefore(banner, progressiveContent);
        } else {
          modalBody.appendChild(banner);
        }
      } catch (error) {
        console.error('Failed to show long article fast notice:', error);
      }
    }

    showNoApiKeyError() {
      this.showProgressiveLoading();
      const sections = this.shadowRoot.querySelectorAll('.ph-summarizer-summary-section');
      sections.forEach(s => s.style.display = 'none');
      const progressiveContent = this.shadowRoot.querySelector('.ph-summarizer-progressive-content');
      if (progressiveContent) {
        progressiveContent.style.display = 'block';
        const msg = document.createElement('div');
        msg.className = 'ph-summarizer-summary-section no-api-key-section';
        const content = document.createElement('div');
        content.className = 'summary-section-content no-api-key-content';

        const icon = document.createElement('div');
        icon.className = 'no-api-key-icon';
        icon.textContent = '\ud83d\udd11';
        content.appendChild(icon);

        const heading = document.createElement('div');
        heading.className = 'no-api-key-heading';
        heading.textContent = 'No API key configured';
        content.appendChild(heading);

        const para = document.createElement('div');
        para.className = 'no-api-key-description';
        para.textContent = 'Add your API key in settings to start summarising articles.';
        content.appendChild(para);

        const btn = document.createElement('button');
        btn.className = 'no-api-key-settings-btn';
        btn.textContent = 'Open Settings';
        btn.addEventListener('click', () => safeSendMessage({ action: 'openOptions' }));
        content.appendChild(btn);

        msg.appendChild(content);
        progressiveContent.appendChild(msg);
      }
      const spinner = this.shadowRoot.querySelector('.ph-summarizer-loading-spinner');
      if (spinner) spinner.style.display = 'none';
    }

    async cycleSummaryType() {
      if (!this.currentArticle) return;
      const current = this.currentSummaryType || 'fast';
      const nextType = current === 'fast' ? 'high_fidelity' : 'fast';
      const warningResult = await this.checkLargeContentWarning(this.currentArticle.wordCount);
      if (!warningResult.proceed) return;
      const requestedSummaryType = warningResult.requestedSummaryType || nextType;
      this.currentSummaryType = requestedSummaryType;
      this.showProgressiveLoading({ summaryType: requestedSummaryType });
      safeSendMessage({
        action: 'getSummary',
        article: this.currentArticle,
        manualSummaryTypeOverride: true,
        requestedSummaryType,
      });
    }

    hideModal() {
      this.modal.setAttribute('data-visible', 'false');
    }

    _formatElapsedSeconds(startTime) {
      if (!startTime) return 0;
      return Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    }

    _stopLoadingTimers() {
      if (this.loadingTimerId) {
        clearInterval(this.loadingTimerId);
        this.loadingTimerId = null;
      }
    }

    _startLoadingTimers() {
      this._stopLoadingTimers();
      if (!Object.keys(this.loadingSectionStartTimes).length) return;
      this.loadingTimerId = window.setInterval(() => {
        this.shadowRoot.querySelectorAll('.model-info.loading').forEach((modelInfo) => {
          const sectionType = modelInfo.getAttribute('data-section-type');
          const model = this.loadingSectionModels[sectionType];
          const startTime = this.loadingSectionStartTimes[sectionType];
          if (!model || !startTime) return;
          modelInfo.textContent = `${model} \u00b7 ${this._formatElapsedSeconds(startTime)}s`;
        });
      }, 1000);
    }

    _seedLoadingModelInfo(sectionModels = {}) {
      this.loadingSectionModels = { ...sectionModels };
      this.loadingSectionStartTimes = {};

      VALID_SECTION_TYPES.forEach((type) => {
        const modelInfo = this.shadowRoot.querySelector(`.${type}-section .model-info`);
        const model = sectionModels[type];
        if (!modelInfo) return;

        if (!model) {
          modelInfo.textContent = '';
          modelInfo.classList.remove('loading');
          modelInfo.style.display = 'none';
          return;
        }

        this.loadingSectionStartTimes[type] = Date.now();
        modelInfo.setAttribute('data-section-type', type);
        modelInfo.textContent = `${model} \u00b7 0s`;
        modelInfo.classList.add('loading');
        modelInfo.style.display = 'inline-flex';
      });

      this._startLoadingTimers();
    }

    _clearLoadingModelInfo() {
      this.loadingSectionModels = {};
      this.loadingSectionStartTimes = {};
      this._stopLoadingTimers();
      this.shadowRoot.querySelectorAll('.model-info').forEach((modelInfo) => {
        modelInfo.textContent = '';
        modelInfo.classList.remove('loading');
        modelInfo.style.display = 'none';
      });
    }

    _renderFooterHint() {
      const footerHint = this.shadowRoot.querySelector('.footer-status-right');
      if (!footerHint) return;

      const shortcut = this.shortcutKey;
      const hasLoadingSections = this.shadowRoot.querySelectorAll('.summary-section-content.loading').length > 0;
      const wordCount = this.currentArticle?.wordCount || 0;
      const isLongArticle = wordCount > 5000;

      if (this.currentSummaryType === 'high_fidelity') {
        if (hasLoadingSections) {
          if (isLongArticle) {
            footerHint.innerHTML = `Long article (${wordCount.toLocaleString()} words)... this may take 10-30s.<br>For a faster summary, press ${escapeHtml(shortcut)}.`;
          } else {
            footerHint.textContent = `For a faster summary, press ${shortcut}.`;
          }
        } else {
          footerHint.textContent = '';
        }
        return;
      }

      if (this.currentSummaryType === 'fast') {
        footerHint.textContent = `For the best quality summary, press ${shortcut}.`;
        return;
      }

      footerHint.textContent = '';
    }

    _showFooter() {
      const footer = this.shadowRoot.querySelector('.ph-summarizer-footer');
      if (footer) footer.style.display = 'block';
      this._renderFooterHint();
    }

    showProgressiveLoading(options = {}) {
      const summaryContent = this.shadowRoot.querySelector('.ph-summarizer-summary-content');
      const progressiveContent = this.shadowRoot.querySelector('.ph-summarizer-progressive-content');
      const loadingSpinner = this.shadowRoot.querySelector('.ph-summarizer-loading-spinner');
      const {
        summaryType = null,
        sectionModels = null,
        longArticleFastOverride = false,
        longArticleWordCount = 0,
        longArticleOriginalEstimatedCost = null,
        longArticleFastEstimatedCost = null,
      } = options;

      this._updateArticleHeader();
      this.currentSummaryType = summaryType;
      this.clearLongArticleFastNotice();
      if (longArticleFastOverride) {
        this.showLongArticleFastNotice(
          longArticleWordCount,
          longArticleOriginalEstimatedCost,
          longArticleFastEstimatedCost
        );
      }

      // Remove any leftover no-API-key block and restore summary sections
      const noKeySection = this.shadowRoot.querySelector('.no-api-key-section');
      if (noKeySection) noKeySection.remove();
      this.shadowRoot.querySelectorAll('.ph-summarizer-summary-section').forEach(s => s.style.display = '');

      // Reset all sections to loading state with spinner
      this.shadowRoot.querySelectorAll('.summary-section-content').forEach(section => {
        while (section.firstChild) section.removeChild(section.firstChild);
        const spinnerDiv = document.createElement('div');
        spinnerDiv.className = 'section-spinner';
        const ring = document.createElement('div');
        ring.className = 'spinner-ring-small';
        spinnerDiv.appendChild(ring);
        section.appendChild(spinnerDiv);
        section.classList.add('loading');
      });

      this.shadowRoot.querySelectorAll('.ph-summarizer-section-copy').forEach(b => b.style.display = 'none');
      this._clearLoadingModelInfo();
      if (sectionModels) this._seedLoadingModelInfo(sectionModels);

      summaryContent.style.display = 'none';
      progressiveContent.style.display = 'block';
      loadingSpinner.style.display = 'none';
      this.modal.setAttribute('data-visible', 'true');
      this._showFooter();
    }

    showProgressiveSummary(type, summary, model, timeMs, showSettingsLink) {
      if (!VALID_SECTION_TYPES.includes(type)) return;
      const sectionContent = this.shadowRoot.querySelector(`.${type}-section .summary-section-content`);
      const copyButton = this.shadowRoot.querySelector(`.${type}-section .ph-summarizer-section-copy`);
      const modelInfo = this.shadowRoot.querySelector(`.${type}-section .model-info`);

      if (!sectionContent) {
        console.error(`Section not found for type: ${type}`);
        return;
      }

      sectionContent.classList.remove('loading');

      if (typeof summary !== 'string') {
        console.error('Invalid summary format:', summary);
        sectionContent.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'error';
        errDiv.textContent = 'Invalid summary format';
        sectionContent.appendChild(errDiv);
        this._clearSectionLoading(type, copyButton, modelInfo);
        return;
      }

      if (summary.startsWith('Error:')) {
        const errorText = summary.replace('Error:', '').trim();
        this._setErrorContent(sectionContent, errorText);
        if (showSettingsLink) {
          const linkP = document.createElement('p');
          linkP.className = 'error-settings-link';
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'open-settings-link';
          a.textContent = 'Open extension settings';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            safeSendMessage({ action: 'openOptions' });
          });
          linkP.appendChild(a);
          sectionContent.querySelector('.error-message').appendChild(linkP);
        }
        this._clearSectionLoading(type, copyButton, modelInfo);
      } else {
        try {
          // renderMarkdown returns HTML from marked with raw HTML tags stripped via
          // marked.use({ renderer: { html: () => '' } }). After assignment, sanitiseHrefsDOM
          // blocks javascript:/data:/vbscript: href schemes on any anchors.
          sectionContent.innerHTML = renderMarkdown(summary);
          sanitiseHrefsDOM(sectionContent);
          if (copyButton) copyButton.style.display = 'flex';

          if (modelInfo && model && timeMs) {
            const timeSeconds = Math.round(timeMs / 1000);
            delete this.loadingSectionStartTimes[type];
            modelInfo.textContent = `${model} \u00b7 ${timeSeconds}s`;
            modelInfo.classList.remove('loading');
            modelInfo.style.display = 'inline-flex';
          }

          this.maybeShowFooter();
        } catch (parseError) {
          console.error(`Error parsing ${type} markdown:`, parseError);
          sectionContent.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'error';
          errDiv.textContent = 'Failed to format the summary';
          sectionContent.appendChild(errDiv);
          this._clearSectionLoading(type, copyButton, modelInfo);
        }
      }
    }

    maybeShowFooter() {
      const stillLoading = this.shadowRoot.querySelectorAll('.summary-section-content.loading');
      if (stillLoading.length === 0) this._stopLoadingTimers();
      this._showFooter();
    }

    hideLoading() {
      this.shadowRoot.querySelector('.ph-summarizer-loading-spinner').style.display = 'none';
    }

    updateLoadingStats(wordCount, readingTimeMinutes) {
      const loadingSubtext = this.shadowRoot.querySelector('.loading-subtext');
      if (loadingSubtext) {
        const stats = document.createElement('div');
        stats.className = 'article-stats';
        const words = document.createElement('span');
        words.className = 'word-count';
        words.textContent = `${wordCount.toLocaleString()} words`;
        const time = document.createElement('span');
        time.className = 'reading-time';
        time.textContent = `${readingTimeMinutes} min read`;
        stats.appendChild(words);
        stats.appendChild(document.createTextNode(' \u00b7 '));
        stats.appendChild(time);
        loadingSubtext.after(stats);
      }
    }

    async checkLargeContentWarning(wordCount) {
      const LARGE_CONTENT_THRESHOLD = 50000;
      if (wordCount < LARGE_CONTENT_THRESHOLD) return { proceed: true, requestedSummaryType: null };

      const items = await new Promise(r => chrome.storage.sync.get(['disableLargeContentWarning'], r));
      if (items.disableLargeContentWarning) return { proceed: true, requestedSummaryType: null };
      const costEstimate = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getLargeContentCostEstimate', wordCount }, (response) => {
          if (chrome.runtime.lastError || !response || response.error) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      });

      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ph-summarizer-warning-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'ph-summarizer-warning-dialog';

        const titleRow = document.createElement('div');
        titleRow.className = 'ph-summarizer-warning-title-row';
        const titleIcon = document.createElement('span');
        titleIcon.className = 'warning-title-icon';
        titleIcon.textContent = '\u26A0\uFE0F';
        titleRow.appendChild(titleIcon);
        const h3 = document.createElement('h3');
        h3.textContent = 'Long content warning';
        titleRow.appendChild(h3);
        dialog.appendChild(titleRow);

        const p = document.createElement('p');
        p.appendChild(document.createTextNode('This page contains '));
        const strong = document.createElement('strong');
        strong.textContent = `${wordCount.toLocaleString()} words`;
        p.appendChild(strong);
        if (costEstimate) {
          p.appendChild(document.createTextNode(
            `. Estimated API cost is about ${costEstimate.fastEstimatedCost} in Fast or ${costEstimate.highFidelityEstimatedCost} in Best quality. Choose how you want to summarise it.`
          ));
        } else {
          p.appendChild(document.createTextNode('. Choose how you want to summarise it.'));
        }
        dialog.appendChild(p);

        const label = document.createElement('label');
        label.className = 'ph-summarizer-warning-checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'warning-dont-ask';
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" Don't warn me again"));
        dialog.appendChild(label);

        const buttons = document.createElement('div');
        buttons.className = 'ph-summarizer-warning-buttons';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'warning-cancel';
        cancelBtn.textContent = 'Cancel';
        const proceedFastBtn = document.createElement('button');
        proceedFastBtn.className = 'warning-proceed';
        proceedFastBtn.textContent = 'Summarise (fast)';
        const proceedBestBtn = document.createElement('button');
        proceedBestBtn.className = 'warning-proceed';
        proceedBestBtn.textContent = 'Summarise (best quality)';
        buttons.appendChild(cancelBtn);
        buttons.appendChild(proceedFastBtn);
        buttons.appendChild(proceedBestBtn);
        dialog.appendChild(buttons);

        overlay.appendChild(dialog);
        this.shadowRoot.appendChild(overlay);

        const cleanup = () => overlay.remove();

        cancelBtn.addEventListener('click', () => {
          cleanup();
          this.hideModal();
          resolve({ proceed: false, requestedSummaryType: null });
        });

        proceedFastBtn.addEventListener('click', () => {
          if (checkbox.checked) {
            chrome.storage.sync.set({ disableLargeContentWarning: true });
          }
          cleanup();
          resolve({ proceed: true, requestedSummaryType: 'fast' });
        });

        proceedBestBtn.addEventListener('click', () => {
          if (checkbox.checked) {
            chrome.storage.sync.set({ disableLargeContentWarning: true });
          }
          cleanup();
          resolve({ proceed: true, requestedSummaryType: 'high_fidelity' });
        });
      });
    }

    _createCheckmarkSvg(size = 16) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('stroke-width', '1.5');
      svg.setAttribute('stroke', 'currentColor');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M4.5 12.75l6 6 9-13.5');
      svg.appendChild(path);
      return svg;
    }

    _clearSectionLoading(type, copyButton, modelInfo) {
      if (copyButton) copyButton.style.display = 'none';
      if (modelInfo) {
        delete this.loadingSectionStartTimes[type];
        modelInfo.classList.remove('loading');
        modelInfo.style.display = 'none';
      }
      this.maybeShowFooter();
    }

    // --- Copy / save ---

    async copySectionContent(sectionType) {
      if (!VALID_SECTION_TYPES.includes(sectionType)) return;
      const sectionContent = this.shadowRoot.querySelector(`.${sectionType}-section .summary-section-content`);
      if (!sectionContent) {
        this.showErrorMessage('Section not found. Please try again.');
        return;
      }

      if (sectionContent.classList.contains('loading')) {
        this.showErrorMessage('This section is still generating. Please wait for it to complete.');
        return;
      }

      const textContent = sectionContent.textContent || sectionContent.innerText;
      if (!textContent || textContent.includes('Error:')) {
        this.showErrorMessage('No content available to copy for this section.');
        return;
      }

      try {
        const markdown = htmlToMarkdown(sectionContent).trim();
        await navigator.clipboard.writeText(markdown);
        this.showSectionCopySuccess(sectionType);
      } catch (error) {
        console.error('Failed to copy section content:', error);
        this.showErrorMessage('Failed to copy the section content. Please try again.');
      }
    }

    showSectionCopySuccess(sectionType) {
      if (!VALID_SECTION_TYPES.includes(sectionType)) return;
      const copyButton = this.shadowRoot.querySelector(`.${sectionType}-section .ph-summarizer-section-copy`);
      if (copyButton) {
        const originalHTML = copyButton.innerHTML;
        copyButton.textContent = '';
        copyButton.appendChild(this._createCheckmarkSvg(16));
        copyButton.classList.add('copied');

        setTimeout(() => {
          copyButton.innerHTML = originalHTML; // restoring own static SVG template
          copyButton.classList.remove('copied');
        }, 2000);
      }
    }

    buildSummaryMarkdown() {
      const summaryData = {
        title: this.currentArticle?.title || document.title,
        author: this.currentArticle?.author || getDomainName(),
        url: window.location.href,
        tldr: this.getSectionContent('tldr'),
        concise: this.getSectionContent('concise'),
        quotes: this.getSectionContent('quotes'),
      };

      const parts = [`# ${summaryData.title}\n`];
      if (summaryData.author) parts.push(`*${summaryData.author}*\n`);
      parts.push(`[${summaryData.url}](${summaryData.url})\n`);
      if (summaryData.tldr) parts.push(`## TL;DR\n\n${summaryData.tldr}\n`);
      if (summaryData.concise) parts.push(`## Summary\n\n${summaryData.concise}\n`);
      if (summaryData.quotes) parts.push(`## Key quotes\n\n${summaryData.quotes}\n`);

      return { markdown: parts.join('\n'), title: summaryData.title };
    }

    async saveSummary() {
      if (!this.hasProgressiveSummaries()) {
        this.showErrorMessage('No summaries available to save. Please wait for them to complete.');
        return;
      }

      const { markdown, title } = this.buildSummaryMarkdown();
      const slug = (title || 'summary').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const filename = `${slug}.md`;

      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showSaveSuccess(filename);
    }

    async copyFullSummary() {
      if (!this.hasProgressiveSummaries()) return;

      const { markdown } = this.buildSummaryMarkdown();
      try {
        await navigator.clipboard.writeText(markdown);
        const btn = this.shadowRoot.querySelector('.ph-summarizer-copy-all-btn');
        if (btn) {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        }
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }

    getSectionContent(sectionType) {
      const sectionContent = this.shadowRoot.querySelector(`.${sectionType}-section .summary-section-content`);
      if (!sectionContent || sectionContent.classList.contains('loading')) return null;
      const textContent = sectionContent.textContent || sectionContent.innerText;
      if (!textContent || textContent.includes('Error:')) return null;
      return htmlToMarkdown(sectionContent).trim();
    }

    showSaveSuccess(filename) {
      const saveButton = this.shadowRoot.querySelector('.ph-summarizer-save-btn');
      if (saveButton) {
        const originalHTML = saveButton.innerHTML;
        saveButton.textContent = '';
        saveButton.appendChild(this._createCheckmarkSvg(14));
        saveButton.appendChild(document.createTextNode(' Saved'));
        saveButton.classList.add('saved');

        setTimeout(() => {
          saveButton.innerHTML = originalHTML; // restoring own static SVG template
          saveButton.classList.remove('saved');
        }, 2000);
      }
    }

    // --- Content type handlers ---

    async handleGoogleDocsContent(content) {
      const gdocsModal = this.shadowRoot.querySelector('.ph-summarizer-gdocs-modal');
      gdocsModal.setAttribute('data-visible', 'false');

      const { wordCount, readingTimeMinutes } = calculateWordStats(content);

      this.currentArticle = this._applyTestWordCountOverride({
        title: document.title || 'Google Doc',
        author: getDomainName(),
        content: content,
        wordCount,
        readingTimeMinutes
      });

      this.showProgressiveLoading();

      const warningResult = await this.checkLargeContentWarning(this.currentArticle.wordCount);
      if (!warningResult.proceed) return;

      safeSendMessage({
        action: 'getSummary',
        article: this.currentArticle,
        requestedSummaryType: warningResult.requestedSummaryType,
      });
    }

    showGoogleDocsDialog() {
      const gdocsModal = this.shadowRoot.querySelector('.ph-summarizer-gdocs-modal');
      const textarea = this.shadowRoot.querySelector('.ph-summarizer-gdocs-textarea');

      gdocsModal.setAttribute('data-visible', 'true');
      textarea.value = '';
      textarea.focus();
    }

    async handlePDF() {
      this.currentArticle = { title: document.title || 'PDF document', author: '' };
      this.showProgressiveLoading();

      const loadingText = this.shadowRoot.querySelector('.loading-text');
      if (loadingText) loadingText.textContent = 'Extracting PDF text...';

      try {
        if (typeof pdfjsLib === 'undefined') {
          const script = document.createElement('script');
          script.src = chrome.runtime.getURL('lib/pdf.min.js');
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load PDF library'));
            document.head.appendChild(script);
          });
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

        const response = await fetch(window.location.href);
        if (!response.ok) throw new Error(`Failed to fetch PDF (HTTP ${response.status})`);
        const arrayBuffer = await response.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        const metadata = await pdf.getMetadata().catch(() => null);
        const pdfTitle = metadata?.info?.Title || document.title || 'PDF document';
        const pdfAuthor = metadata?.info?.Author || '';
        this.currentArticle = { title: pdfTitle, author: pdfAuthor };
        this._updateArticleHeader(this.currentArticle);

        const pageTexts = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) =>
            pdf.getPage(i + 1).then(page => page.getTextContent()).then(tc => tc.items.map(item => item.str).join(' '))
          )
        );
        const text = pageTexts.join('\n\n');
        pdf.destroy();

        if (!text || text.trim().length === 0) {
          this.hideLoading();
          this.showErrorMessage('Could not extract any text from this PDF. It may be image-based (scanned).');
          return;
        }

        const { wordCount, readingTimeMinutes } = calculateWordStats(text);
        const article = this._applyTestWordCountOverride({
          title: pdfTitle,
          author: pdfAuthor,
          content: text,
          wordCount,
          readingTimeMinutes
        });
        this.updateLoadingStats(article.wordCount, article.readingTimeMinutes);

        const warningResult = await this.checkLargeContentWarning(article.wordCount);
        if (!warningResult.proceed) return;

        if (loadingText) loadingText.textContent = 'Summarising PDF...';

        this.currentArticle = article;
        this._updateArticleHeader(article);
        safeSendMessage({
          action: 'getSummary',
          article,
          requestedSummaryType: warningResult.requestedSummaryType,
        });
      } catch (error) {
        console.error('PDF extraction failed:', error);
        this.hideLoading();
        this.showErrorMessage(`Failed to read PDF: ${error.message}`);
      }
    }

    async handleYouTube() {
      const videoId = new URLSearchParams(window.location.search).get('v');
      if (!videoId) {
        this.showProgressiveLoading();
        this.hideLoading();
        this.showErrorMessage('YouTube summarisation is only available on video watch pages.');
        return;
      }

      this.showProgressiveLoading();

      try {
        const transcript = await extractYouTubeTranscript();
        const title = document.querySelector('yt-formatted-string.ytd-watch-metadata, h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string')?.textContent?.trim()
          || document.title.replace(' - YouTube', '').trim();
        const channel = document.querySelector('#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a')?.textContent?.trim()
          || document.querySelector('#channel-name')?.textContent?.trim()
          || 'YouTube';

        const { wordCount, readingTimeMinutes } = calculateWordStats(transcript);

        this.currentArticle = this._applyTestWordCountOverride({
          title,
          author: channel,
          content: transcript,
          wordCount,
          readingTimeMinutes
        });
        this.updateLoadingStats(this.currentArticle.wordCount, this.currentArticle.readingTimeMinutes);

        const warningResult = await this.checkLargeContentWarning(this.currentArticle.wordCount);
        if (!warningResult.proceed) return;

        chrome.runtime.sendMessage({
          action: 'getSummary',
          article: this.currentArticle,
          requestedSummaryType: warningResult.requestedSummaryType,
        });
      } catch (error) {
        this.hideLoading();
        this.showErrorMessage(error.message);
      }
    }

    // --- Caching ---

    hasProgressiveSummaries() {
      return Array.from(this.shadowRoot.querySelectorAll('.summary-section-content'))
        .some(s => !s.classList.contains('loading') && s.textContent && !s.textContent.includes('Error:'));
    }

    showExistingProgressiveSummaries() {
      const summaryContent = this.shadowRoot.querySelector('.ph-summarizer-summary-content');
      const progressiveContent = this.shadowRoot.querySelector('.ph-summarizer-progressive-content');
      const loadingSpinner = this.shadowRoot.querySelector('.ph-summarizer-loading-spinner');

      this._updateArticleHeader();

      summaryContent.style.display = 'none';
      progressiveContent.style.display = 'block';
      loadingSpinner.style.display = 'none';
      this.modal.setAttribute('data-visible', 'true');
    }

    clearCachedSummary() {
      this.currentArticle = null;
      this.currentSummaryType = null;
      this._clearLoadingModelInfo();
      this.cachedUrl = null;
    }

    isCachedSummaryForCurrentUrl() {
      return this.cachedUrl ? this.cachedUrl === window.location.href : false;
    }
  }

  // --- Initialisation ---

  window.articleSummarizerInstance = new ArticleSummarizer();

  let currentUrl = window.location.href;

  // Detect SPA-style URL changes to invalidate cached summaries.
  if (typeof navigation !== 'undefined') {
    navigation.addEventListener('navigate', () => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        window.articleSummarizerInstance.clearCachedSummary();
      }
    });
  } else {
    setInterval(() => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        window.articleSummarizerInstance.clearCachedSummary();
      }
    }, 1000);
  }

  window.addEventListener('popstate', () => {
    window.articleSummarizerInstance.clearCachedSummary();
  });

  // Summary output depends on user settings, so URL-only cache is stale after changes.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') return;
    if (!Object.keys(changes).some(key => SUMMARY_CACHE_SETTING_KEYS.has(key))) return;
    window.articleSummarizerInstance.clearCachedSummary();
  });

  // Message listener
  chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    try {
      if (request.action === 'ping') {
        sendResponse({ status: 'alive' });
        return;
      }
      if (request.action === 'summarize') {
        if (window.location.hostname === 'www.youtube.com' || window.location.hostname === 'youtube.com') {
          window.articleSummarizerInstance.handleYouTube();
          return;
        }

        if (window.location.pathname.endsWith('.pdf') || document.contentType === 'application/pdf') {
          window.articleSummarizerInstance.handlePDF();
          return;
        }

        if (window.location.hostname === 'docs.google.com') {
          window.articleSummarizerInstance.showGoogleDocsDialog();
          return;
        }

        if (window.articleSummarizerInstance.hasProgressiveSummaries() &&
            window.articleSummarizerInstance.isCachedSummaryForCurrentUrl()) {
          if (window.articleSummarizerInstance.modal?.getAttribute('data-visible') === 'true') {
            window.articleSummarizerInstance.cycleSummaryType();
          } else {
            window.articleSummarizerInstance.showExistingProgressiveSummaries();
          }
          return;
        }

        window.articleSummarizerInstance.showProgressiveLoading();

        const article = await window.articleSummarizerInstance.extractArticle();
        window.articleSummarizerInstance.updateLoadingStats(article.wordCount, article.readingTimeMinutes);

        const warningResult = await window.articleSummarizerInstance.checkLargeContentWarning(article.wordCount);
        if (!warningResult.proceed) return;

        safeSendMessage({
          action: 'getSummary',
          article,
          requestedSummaryType: warningResult.requestedSummaryType,
        });
      } else if (request.action === 'showProgressiveLoading') {
        window.articleSummarizerInstance.showProgressiveLoading({
          summaryType: request.summaryType,
          sectionModels: request.sectionModels,
          longArticleFastOverride: request.longArticleFastOverride,
          longArticleWordCount: request.longArticleWordCount,
          longArticleOriginalEstimatedCost: request.longArticleOriginalEstimatedCost,
          longArticleFastEstimatedCost: request.longArticleFastEstimatedCost,
        });
      } else if (request.action === 'showProgressiveSummary') {
        // Ignore stale results from a previous page
        if (request.sourceUrl && request.sourceUrl !== window.location.href) {
          console.log('Ignoring stale summary result for', request.sourceUrl);
          return;
        }
        window.articleSummarizerInstance.showProgressiveSummary(request.type, request.summary, request.model, request.timeMs, request.showSettingsLink);
        if (!window.articleSummarizerInstance.cachedUrl) {
          window.articleSummarizerInstance.cachedUrl = window.location.href;
        }
      } else if (request.action === 'noApiKey') {
        window.articleSummarizerInstance.showNoApiKeyError();
      } else if (request.action === 'showCostAlert') {
        window.articleSummarizerInstance.showCostAlert(request.amount, request.threshold);
      } else {
        console.error('Unknown action received:', request.action);
        window.articleSummarizerInstance.showErrorMessage('Received an unknown command. Please try again.');
      }
    } catch (error) {
      console.error('Error processing message:', error);
      window.articleSummarizerInstance.hideLoading();
      window.articleSummarizerInstance.showErrorMessage(error.message);
    }
  });

})();
