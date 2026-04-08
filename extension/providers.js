// providers.js -- Direct API calling logic + prompt defaults for BYOK summarisation

// ---------------------------------------------------------------------------
// Default pricing (USD per 1M tokens) — updated from wow.pjh.is/such-summary/api/pricing.json
// ---------------------------------------------------------------------------

const DEFAULT_PRICING = {
  'claude-opus-4-6':        { input: 5.00,  output: 25.00 },
  'claude-haiku-4-5':       { input: 1.00,  output: 5.00 },
};

const PRICING_ENDPOINT = 'https://wow.pjh.is/such-summary/api/pricing.json';
const PRICING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Mode presets (cross-provider)
// ---------------------------------------------------------------------------

const MODE_PRESETS = {
  fast: {
    tldr:    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    concise: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    quotes:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
  high_fidelity: {
    tldr:    { provider: 'anthropic', model: 'claude-opus-4-6' },
    concise: { provider: 'anthropic', model: 'claude-opus-4-6' },
    quotes:  { provider: 'anthropic', model: 'claude-opus-4-6' },
  },
};

const VALID_SUMMARY_TYPES = ['fast', 'high_fidelity'];

const SUMMARY_TYPE_LABELS = {
  fast: 'Fast',
  high_fidelity: 'Best quality',
};

const LONG_ARTICLE_FAST_MODEL_THRESHOLD = 10000;

function sanitizeSummaryType(summaryType) {
  return VALID_SUMMARY_TYPES.includes(summaryType) ? summaryType : null;
}

function sanitizeDomainDefaults(domainDefaults = {}) {
  return Object.fromEntries(
    Object.entries(domainDefaults || {}).filter(([, type]) => !!sanitizeSummaryType(type))
  );
}

function getDefaultSummaryType({ summaryType, claudeApiKey } = {}) {
  const sanitized = sanitizeSummaryType(summaryType);
  if (sanitized) return sanitized;
  if (claudeApiKey) return 'high_fidelity';
  return 'fast';
}

function shouldPreferFastForLongArticles(preferFastForLongArticles) {
  return preferFastForLongArticles !== false;
}

// ---------------------------------------------------------------------------
// Length-adaptive tiers
// ---------------------------------------------------------------------------

// Returns summary parameters scaled to content length.
function getContentTier(wordCount) {
  if (wordCount > 15000) return { tldrSentences: '3–4', bullets: '12–18', maxQuotes: 10, tier: 'very_long' };
  if (wordCount > 5000)  return { tldrSentences: '2–3', bullets: '8–12', maxQuotes: 7, tier: 'long' };
  if (wordCount > 2000)  return { tldrSentences: '2', bullets: '5–8', maxQuotes: 5, tier: 'medium' };
  return                        { tldrSentences: '1–2', bullets: '3–5', maxQuotes: 3, tier: 'short' };
}

// Substitute length-adaptive template variables in any prompt string.
// Works on both default and user-customised prompts.
function substituteTierVars(template, tier) {
  return template
    .replace(/\{\{TLDR_SENTENCES\}\}/g, tier.tldrSentences)
    .replace(/\{\{BULLET_RANGE\}\}/g, tier.bullets)
    .replace(/\{\{MAX_QUOTES\}\}/g, String(tier.maxQuotes))
    .replace(/\{\{MAX_QUOTES_WORDS\}\}/g, String(tier.maxQuotes * 60));
}

// ---------------------------------------------------------------------------
// Max tokens per summary type (base values, scaled up for longer content)
// ---------------------------------------------------------------------------

const BASE_MAX_TOKENS = {
  tldr: 512,
  concise: 1024,
  quotes: 1024,
};

const TIER_TOKEN_MULTIPLIER = {
  short: 0.75,
  medium: 1,
  long: 1.5,
  very_long: 2,
};

// ---------------------------------------------------------------------------
// Default prompt templates
// ---------------------------------------------------------------------------

// Default prompts use {{VARIABLE}} placeholders for length-adaptive values.
// These are substituted at summarisation time via substituteTierVars().
// Users can use the same placeholders in custom prompts.
const DEFAULT_PROMPTS = {
  tldr: `Generate a TL;DR summary of the piece, delivered as **valid Markdown** only.

- Write {{TLDR_SENTENCES}} crisp sentences. Each sentence should be short and concise (<10 words per sentence).

- No meta-phrases or filler.

- Use short words (e.g. "big effect" instead of "significant effect").

- If there are important statistics, consider mentioning them.

- Do not begin your response with a heading (e.g. "tl;dr"). Instead, begin with the summary.

**Important:** These examples show the desired structure and style. Do NOT copy their specific content, statistics, or topics. Focus on summarizing the actual provided content.

## Audience assumptions
• Reader is PhD-level, well read in AI/ML, effective altruism (EA), longtermism, philosophy, and adjacent domains.
• Use standard acronyms wherever possible. Do not define them, e.g. "LLMs" not "Large Language Models (LLMs)".
• Elide obvious contextual filler or hand-holding.

## General style rules
• No meta-references such as "this article argues", "the author writes", etc.
• If referring to the author, mention them by full name at first reference, then surname only.
• Use as many words as necessary to be complete, but add no padding.`,

  concise: `Generate a concise summary of the piece, delivered as **valid Markdown** only.

Audience assumptions
• Reader is PhD-level, well read in AI/ML, effective altruism (EA), longtermism, philosophy, and adjacent domains.
• Use standard acronyms wherever possible. Do not define them, e.g. "LLMs" not "Large Language Models (LLMs)".
• Elide obvious contextual filler or hand-holding.

## Concise summary
---
• {{BULLET_RANGE}} bullets capturing the core arguments.
• Begin each bullet with a **bold** keyword or phrase.
• If the material maps neatly to rows/columns, present it in a Markdown table instead of bullets.

General style rules
• Do not begin your response with a heading (e.g. "Concise summary"). Instead, begin with the summary text itself.
• No meta-references such as "this article argues", "the author writes", etc.
• Mention the author by full name at first reference, then surname only.
• Use as many words as necessary to be complete, but add no padding.
• Apart from the specified level-two heading (## Concise summary), do not add any other headings or titles.`,

  quotes: `Extract key quotes from the piece, delivered as **valid Markdown** only.

Your task: Identify 0–{{MAX_QUOTES}} quotes that add substantial value beyond what a summary would convey. Many articles need NO quotes—only select quotes when they meet one or more of these criteria:

**Quote selection criteria**
• **Critical precision**: The exact wording is crucial for understanding (e.g., specific claims, definitions, technical statements)
• **Memorable insight**: Particularly eloquent, surprising, or counterintuitive phrasing that captures the essence
• **Data/evidence**: Specific statistics, findings, or claims where precision matters
• **Author's voice**: Reveals something important about the author's perspective, emotion, or stance
• **Turning points**: Marks a crucial shift in argument or introduces a key concept

**Format requirements**
• If NO quotes meet the criteria, return exactly: "No essential quotes identified."
• For each selected quote:
  - Present the quote in a blockquote (> prefix)
  - Follow with one sentence explaining why this quote matters
  - The explanation must be a direct statement—never start with "This quote" or any variation of it
  - Separate quotes with a blank line
• Maximum {{MAX_QUOTES}} quotes total
• Combined quotes should not exceed ~{{MAX_QUOTES_WORDS}} words

**Quality standards**
• Never include quotes just to have quotes
• Avoid generic statements that could be paraphrased
• Skip quotes that merely repeat the main argument
• Prioritize substance over style (unless style is the substance)

Audience assumptions
• Reader is PhD-level, well-read in relevant domains
• Reader will see this alongside comprehensive summaries
• Quotes should complement, not duplicate, summary content`,
};

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

// Split prompt into system (instructions) and user (article content) messages.
function renderPromptParts(template, article) {
  const articleText = `Title: ${article.title || 'Untitled'}
Author: ${article.author || 'Unknown Author'}

${article.content || ''}`;
  return { system: template, user: articleText };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function cleanLineBreaks(text) {
  return text
    .replace(/(?<!\n)\n(?!\n)/g, ' ')
    .replace(/\n\n+/g, '\n\n')
    .trim();
}

// Strip leading headings that some models add despite prompt instructions
function stripLeadingHeading(text) {
  return text.replace(/^(?:#{1,3}\s+.+|\*\*.+?\*\*)\s*\n+/, '').trim();
}

// Normalise quotes output so explanations are always outside the blockquote.
function fixQuotesFormatting(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      const group = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        group.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const quoteLines = [];
      const explLines = [];
      let inExplanation = false;
      for (const gl of group) {
        const trimmed = gl.trim();
        if (trimmed === '') {
          inExplanation = true;
          continue;
        }
        if (inExplanation) {
          const deItalic = trimmed.replace(/^\*(.+?)\*$/, '$1');
          explLines.push(deItalic);
        } else if (/^\*[^*]/.test(trimmed)) {
          inExplanation = true;
          explLines.push(trimmed.replace(/^\*(.+?)\*$/, '$1'));
        } else if (quoteLines.length > 0 && !/[""\u201c\u201d]/.test(trimmed)) {
          inExplanation = true;
          explLines.push(trimmed);
        } else {
          quoteLines.push(gl);
        }
      }
      for (const ql of quoteLines) {
        out.push('> ' + ql);
      }
      if (explLines.length) {
        out.push('');
        for (const el of explLines) out.push(el);
      }
      out.push('');
    } else {
      const trimmed = line.trim();
      if (/^\*[^*]+\*$/.test(trimmed)) {
        out.push(trimmed.replace(/^\*(.+?)\*$/, '$1'));
      } else {
        out.push(line);
      }
      i++;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Convert bold-leading lines without bullet prefix into proper markdown list items.
function ensureBulletList(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const boldLines = lines.filter(l => /^\*\*[^*]+\*\*[:\s]/.test(l.trim()));
  if (boldLines.length >= 3 && boldLines.length >= lines.length * 0.5) {
    return text.replace(/^(\*\*[^*]+\*\*)/gm, '- $1');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Provider API functions
// ---------------------------------------------------------------------------

async function callAnthropic({ apiKey, model, systemPrompt, userPrompt, maxTokens, signal }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic API error (${response.status})`);
  }
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Unexpected Anthropic API response format');
  return {
    text,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

const PROVIDER_CALLERS = {
  anthropic: callAnthropic,
};

// ---------------------------------------------------------------------------
// Main summarise function
// ---------------------------------------------------------------------------

async function summarise(provider, apiKey, model, summaryType, article, customPrompt, signal) {
  const wordCount = article.wordCount || 3000; // fallback to medium tier
  const tier = getContentTier(wordCount);

  const rawTemplate = customPrompt || DEFAULT_PROMPTS[summaryType];
  if (!rawTemplate) {
    throw new Error(`Unknown summary type: ${summaryType}`);
  }

  const template = substituteTierVars(rawTemplate, tier);

  const { system, user } = renderPromptParts(template, article);
  const baseMaxTokens = BASE_MAX_TOKENS[summaryType] || 1024;
  const tierMultiplier = TIER_TOKEN_MULTIPLIER[tier.tier] || 1;
  const maxTokens = Math.round(baseMaxTokens * tierMultiplier);

  const caller = PROVIDER_CALLERS[provider];
  if (!caller) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const callerOpts = { apiKey, model, maxTokens, systemPrompt: system, userPrompt: user, signal };
  const startTime = Date.now();
  const result = await caller(callerOpts);
  const timeMs = Date.now() - startTime;

  let summary = stripLeadingHeading(result.text);
  if (summaryType === 'tldr') {
    summary = cleanLineBreaks(summary);
  } else if (summaryType === 'concise') {
    summary = ensureBulletList(summary);
  } else if (summaryType === 'quotes') {
    summary = fixQuotesFormatting(summary);
  }

  return {
    summary,
    model,
    timeMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const COST_THRESHOLDS = [5, 25, 50, 100];

function estimateSummaryRunCostForMode(wordCount, summaryMode, pricing = DEFAULT_PRICING) {
  const preset = MODE_PRESETS[summaryMode];
  if (!preset) return 0;

  const normalizedWordCount = Math.max(0, wordCount || 0);
  const tier = getContentTier(normalizedWordCount || 3000);
  const tierMultiplier = TIER_TOKEN_MULTIPLIER[tier.tier] || 1;
  // Include ~500 tokens per request for system prompt overhead
  const inputTokensPerRequest = Math.round(normalizedWordCount * 1.3) + 500;

  let total = 0;
  for (const sectionType of ['tldr', 'concise', 'quotes']) {
    const model = preset[sectionType]?.model;
    const modelPricing = pricing[model] || pricing['claude-opus-4-6'] || { input: 5.00, output: 25.00 };
    const outputTokens = Math.round((BASE_MAX_TOKENS[sectionType] || 1024) * tierMultiplier);
    total += ((inputTokensPerRequest * modelPricing.input) + (outputTokens * modelPricing.output)) / 1_000_000;
  }

  return total;
}

// Estimate cost in USD for a single usage log entry.
function estimateEntryCost(entry, pricing) {
  const modelPricing = pricing[entry.model];
  if (!modelPricing) {
    // Fall back to most expensive known model for safety
    const fallback = pricing['claude-opus-4-6'] || { input: 5.00, output: 25.00 };
    return ((entry.inputTokens || 0) * fallback.input + (entry.outputTokens || 0) * fallback.output) / 1_000_000;
  }
  return ((entry.inputTokens || 0) * modelPricing.input + (entry.outputTokens || 0) * modelPricing.output) / 1_000_000;
}

// Estimate total cost in USD for an array of usage log entries.
function estimateTotalCost(logs, pricing) {
  let total = 0;
  for (const entry of logs) {
    total += estimateEntryCost(entry, pricing);
  }
  return total;
}

// Find the highest cost threshold that has been crossed.
function highestCrossedThreshold(amount) {
  let highest = 0;
  for (const t of COST_THRESHOLDS) {
    if (amount >= t) highest = t;
  }
  return highest;
}

// Fetch pricing from remote endpoint; returns model pricing object or null on failure.
async function fetchRemotePricing() {
  try {
    const response = await fetch(PRICING_ENDPOINT, { cache: 'no-cache' });
    if (!response.ok) return null;
    const data = await response.json();
    return data.models || null;
  } catch {
    return null;
  }
}

// Get pricing: use cached if fresh, otherwise try remote, fall back to defaults.
// Only usable in contexts with chrome.storage (background/options, not content script).
async function getCachedOrDefaultPricing() {
  if (typeof chrome === 'undefined' || !chrome.storage) return DEFAULT_PRICING;
  const items = await new Promise(r => chrome.storage.local.get(['cachedPricing', 'cachedPricingTs'], r));
  const age = items.cachedPricingTs ? Date.now() - new Date(items.cachedPricingTs).getTime() : Infinity;

  if (items.cachedPricing && age < PRICING_CACHE_MAX_AGE_MS) {
    return { ...DEFAULT_PRICING, ...items.cachedPricing };
  }

  // Try refreshing from remote
  const remote = await fetchRemotePricing();
  if (remote) {
    await new Promise(r => chrome.storage.local.set({
      cachedPricing: remote,
      cachedPricingTs: new Date().toISOString(),
    }, r));
    return { ...DEFAULT_PRICING, ...remote };
  }

  return items.cachedPricing ? { ...DEFAULT_PRICING, ...items.cachedPricing } : DEFAULT_PRICING;
}

// Format a USD cost for display (e.g. "$0.0042" or "$12.34").
function formatCostUSD(amount) {
  if (amount < 0.01) return '$' + amount.toFixed(4);
  return '$' + amount.toFixed(2);
}
