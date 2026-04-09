// Article content extraction functions used by the summariser.
// Loaded before content.js via chrome.scripting.executeScript.

window.SummarizerExtractors = (() => {

  function calculateWordStats(text) {
    const wordCount = text.trim().split(/\s+/).length;
    return { wordCount, readingTimeMinutes: Math.max(1, Math.round(wordCount / 225)) };
  }

  // Site-specific rules for overriding extracted article fields.
  // Each key is a hostname (or *.domain for wildcard subdomains).
  // Values are objects mapping field names to transform functions: (article, url) => value.
  // Return null to suppress a field (e.g. hide garbage author).

  const stripTrailingDashSegment = (article) => {
    if (!article.title) return article.title;
    const lastDashIndex = article.title.lastIndexOf(' - ');
    return lastDashIndex !== -1 ? article.title.substring(0, lastDashIndex).trim() : article.title;
  };

  const findVulcanAuthor = () => {
    const el = document.querySelector('.UsersNameDisplay-noColor');
    return el ? el.textContent.trim() : null;
  };

  const SITE_RULES = {
    '*.wikipedia.org': {
      author: () => null,
    },
    'mail.google.com': {
      title: stripTrailingDashSegment,
    },
    'gmail.com': {
      title: stripTrailingDashSegment,
    },
    'www.lesswrong.com': {
      author: findVulcanAuthor,
    },
    'forum.effectivealtruism.org': {
      author: findVulcanAuthor,
    },
  };

  function cleanAuthorString(authorString) {
    if (!authorString) return authorString;

    // Discard URLs (e.g. Facebook profile from meta[property="article:author"])
    if (/^https?:\/\//i.test(authorString.trim())) return null;

    // Split on "Published" or "published" and keep only the first part
    const publishedIndex = authorString.toLowerCase().indexOf('published');
    if (publishedIndex !== -1) {
      return authorString.substring(0, publishedIndex).trim();
    }

    return authorString;
  }

  function getDomainName() {
    try {
      const url = new URL(window.location.href);
      return url.hostname;
    } catch (error) {
      console.error('Error extracting domain name:', error);
      return 'Unknown Source';
    }
  }

  function findGmailSender() {
    try {
      // Look for the sender name in Gmail's DOM structure
      // The sender name is typically in a span with class "gD" and has a "name" attribute
      const senderElements = document.querySelectorAll('span[class*="gD"][name]');

      for (const element of senderElements) {
        const name = element.getAttribute('name');
        if (name && name.trim()) {
          return cleanAuthorString(name);
        }
      }

      // Fallback: look for any span with a name attribute that contains sender info
      const nameElements = document.querySelectorAll('span[name]');
      for (const element of nameElements) {
        const name = element.getAttribute('name');
        if (name && name.trim() && !name.includes('@')) {
          // Avoid email addresses, look for actual names
          return cleanAuthorString(name);
        }
      }

      // Another fallback: look for text content in the sender area
      const senderArea = document.querySelector('h3[class*="iw"]');
      if (senderArea) {
        const text = senderArea.textContent.trim();
        if (text && !text.includes('@')) {
          // Clean up the text to get just the sender name
          const cleaned = cleanAuthorString(text);
          if (cleaned && cleaned.length > 0) {
            return cleaned;
          }
        }
      }
    } catch (error) {
      console.error('Error finding Gmail sender:', error);
    }

    return null;
  }

  function findAuthor() {
    try {
      // Special handling for Gmail - try to extract sender name
      if (window.location.hostname === 'mail.google.com' || window.location.hostname === 'gmail.com') {
        const gmailAuthor = findGmailSender();
        if (gmailAuthor) {
          return gmailAuthor;
        }
      }

      // Common selectors for author information
      const authorSelectors = [
        '[rel="author"]',
        '[class*="author"]',
        '[class*="byline"]',
        '[data-author]',
        'meta[name="author"]',
        'meta[property="author"]',
        'meta[property="article:author"]'
      ];

      for (const selector of authorSelectors) {
        const authorElement = document.querySelector(selector);
        if (authorElement) {
          // Handle meta tags differently
          if (authorElement.tagName.toLowerCase() === 'meta') {
            const content = authorElement.getAttribute('content');
            return cleanAuthorString(content);
          }
          // Get text content for other elements
          const authorText = authorElement.textContent.trim();
          if (authorText) {
            return cleanAuthorString(authorText);
          }
        }
      }
    } catch (error) {
      console.error('Error finding author:', error);
    }

    // Return domain name instead of "Unknown Author"
    return getDomainName();
  }

  function applySiteRules(articleInfo) {
    const hostname = window.location.hostname;
    const rules = SITE_RULES[hostname]
      || Object.entries(SITE_RULES)
          .find(([pattern]) => pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1)))
          ?.[1];
    if (!rules) return articleInfo;

    for (const [field, transform] of Object.entries(rules)) {
      articleInfo[field] = transform(articleInfo, window.location.href);
    }
    return articleInfo;
  }

  // Extract article content from the current page using Readability.
  // Returns { title, author, content, wordCount, readingTimeMinutes }.
  function extractArticle() {
    try {
      if (typeof Readability === 'undefined') {
        console.log('Readability not available in content script context');
        throw new Error('Readability library not loaded. Please refresh the page and try again.');
      }

      const documentClone = document.cloneNode(true);
      const article = new Readability(documentClone).parse();

      if (!article) {
        console.error('Failed to parse article content');
        throw new Error('Could not extract article content from this page. Please try a different article.');
      }

      let author = cleanAuthorString(article.byline) || findAuthor();

      if (!article.textContent || article.textContent.length === 0) {
        console.error('Article content is empty');
        throw new Error('The extracted article appears to be empty. Please try a different article.');
      }

      const { wordCount, readingTimeMinutes } = calculateWordStats(article.textContent);

      if (wordCount === 0) {
        throw new Error('No readable content found. This page may not contain extractable text.');
      }

      const result = applySiteRules({
        title: article.title,
        author: author,
        content: article.textContent,
        wordCount,
        readingTimeMinutes
      });

      return result;
    } catch (error) {
      console.error('Error extracting article:', error);
      throw error;
    }
  }

  // --- YouTube transcript extraction ---

  function parseYouTubeCaptionXML(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const texts = doc.querySelectorAll('text');

    if (!texts.length) return null;

    const lines = Array.from(texts).map(node => {
      // Caption text nodes contain HTML-entity-encoded plain text.
      // Use textContent which already decodes XML entities safely.
      return node.textContent.trim();
    });

    return lines.filter(Boolean).join(' ');
  }

  function getYouTubePageDataFromDOM(expectedVideoId) {
    try {
      let playerHtml = '';
      let configHtml = '';
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        try {
          const text = s.textContent;
          if (!text) continue;
          if (!playerHtml && text.includes('ytInitialPlayerResponse')) playerHtml = text;
          if (!configHtml && text.includes('INNERTUBE_CONTEXT')) configHtml = text;
          if (playerHtml && configHtml) break;
        } catch { /* ignore Trusted Types errors on external scripts */ }
      }
      const pageData = parseYouTubePageData(playerHtml, configHtml);
      // After SPA navigation, script tags still contain the initial page load's
      // data. If the parsed video ID doesn't match the current URL, discard it
      // so the caller falls through to the network fetch.
      if (expectedVideoId && pageData.parsedVideoId && pageData.parsedVideoId !== expectedVideoId) {
        console.log('[YT-extract] DOM page data is for video', pageData.parsedVideoId, 'but expected', expectedVideoId, '— skipping stale DOM data');
        return {};
      }
      return pageData;
    } catch (error) {
      console.error('Error reading YouTube page data from DOM:', error);
      return {};
    }
  }

  async function fetchYouTubePageDataFromNetwork(videoId) {
    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      if (!response.ok) return {};
      const html = await response.text();
      return parseYouTubePageData(html, html);
    } catch (error) {
      console.error('Error fetching YouTube page data:', error);
      return {};
    }
  }

  function parseYouTubePageData(playerHtml, configHtml) {
    let captionTracks = null;
    let parsedVideoId = null;
    if (playerHtml) {
      const marker = 'ytInitialPlayerResponse';
      const markerIdx = playerHtml.indexOf(marker);
      if (markerIdx !== -1) {
        const braceStart = playerHtml.indexOf('{', markerIdx + marker.length);
        if (braceStart !== -1) {
          const jsonStr = extractBalancedJSON(playerHtml, braceStart);
          if (jsonStr) {
            try {
              const playerResponse = JSON.parse(jsonStr);
              captionTracks = playerResponse?.captions
                ?.playerCaptionsTracklistRenderer?.captionTracks || null;
              parsedVideoId = playerResponse?.videoDetails?.videoId || null;
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }

    let innertubeContext = null;
    const searchHtml = configHtml || playerHtml;
    if (searchHtml) {
      const ctxMarker = '"INNERTUBE_CONTEXT":';
      const ctxIdx = searchHtml.indexOf(ctxMarker);
      if (ctxIdx !== -1) {
        const braceStart = searchHtml.indexOf('{', ctxIdx + ctxMarker.length);
        if (braceStart !== -1) {
          const ctxStr = extractBalancedJSON(searchHtml, braceStart);
          if (ctxStr) {
            try { innertubeContext = JSON.parse(ctxStr); } catch { /* ignore */ }
          }
        }
      }
    }

    let getTranscriptParams = null;
    const paramsSource = playerHtml || configHtml;
    if (paramsSource) {
      const paramsMatch = paramsSource.match(/"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/);
      if (paramsMatch) {
        getTranscriptParams = paramsMatch[1];
      }
    }

    return { captionTracks, innertubeContext, getTranscriptParams, parsedVideoId };
  }

  function extractBalancedJSON(str, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return str.substring(start, i + 1); }
      }
    }
    return null;
  }

  async function getYouTubeTranscriptFromCaptions(captionTracks) {
    try {
      const track = captionTracks.find(t => t.languageCode === 'en' && !t.kind)
        || captionTracks.find(t => t.languageCode === 'en')
        || captionTracks.find(t => t.languageCode?.startsWith('en'))
        || captionTracks[0];

      if (!track?.baseUrl) return null;

      const response = await fetch(track.baseUrl);
      const xml = await response.text();
      return parseYouTubeCaptionXML(xml);
    } catch (error) {
      console.error('[YT-extract] Error fetching YouTube captions:', error);
      return null;
    }
  }

  async function getYouTubeTranscriptFromAPI(videoId, innertubeContext, getTranscriptParams) {
    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalVideoId: videoId,
          context: innertubeContext,
          params: getTranscriptParams,
        }),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const segments = data?.actions?.[0]?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
        ?.transcriptSegmentListRenderer?.initialSegments;

      if (!segments?.length) return null;

      return segments
        .map(s => s.transcriptSegmentRenderer?.snippet?.runs?.map(r => r.text).join('') || '')
        .filter(Boolean)
        .join(' ');
    } catch (error) {
      console.error('Error fetching YouTube transcript from API:', error);
      return null;
    }
  }

  function getYouTubeTranscriptErrorMessage(panelError, pageData) {
    const expectedPanelErrors = [
      'No transcript panel found for this video.',
      'Transcript panel opened but no segments loaded.',
    ];

    const hasCaptionTracks = Boolean(pageData?.captionTracks?.length);
    const hasTranscriptEndpoint = Boolean(pageData?.innertubeContext && pageData?.getTranscriptParams);
    const likelyNoTranscriptAvailable = !hasCaptionTracks && !hasTranscriptEndpoint;
    const isExpectedPanelFailure = expectedPanelErrors.includes(panelError);

    if (likelyNoTranscriptAvailable || isExpectedPanelFailure) {
      return (
        'No transcript found. The YouTube creator may have disabled transcripts for this video.'
      );
    }

    return (
      'Could not load the transcript for this video right now. This can happen if YouTube is being ' +
      'temperamental or if transcript access is restricted. Please try again in a moment, or check ' +
      'whether "CC" is available in the player.'
    );
  }

  async function extractYouTubeTranscript() {
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    if (!videoId) throw new Error('Could not extract video ID from URL.');

    // Primary strategy: ask the background script to open YouTube's transcript
    // panel in the MAIN world and read the text from the DOM. This works
    // regardless of YouTube's caption URL format (including variant=gemini).
    const panelResult = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getYouTubeTranscript', videoId }, resolve);
    });
    if (panelResult?.transcript) return panelResult.transcript;

    console.log('YouTube transcript panel approach failed, trying fallbacks:', panelResult?.error || 'unknown');

    // Fallback: parse caption track URLs from page data and fetch XML directly.
    // This handles older YouTube pages that still serve standard timedtext XML.
    let pageData = getYouTubePageDataFromDOM(videoId);
    if (!pageData.captionTracks?.length && !pageData.getTranscriptParams) {
      pageData = await fetchYouTubePageDataFromNetwork(videoId);
    }

    if (pageData.captionTracks?.length) {
      const transcript = await getYouTubeTranscriptFromCaptions(pageData.captionTracks);
      if (transcript) return transcript;
    }

    if (pageData.innertubeContext && pageData.getTranscriptParams) {
      const transcript = await getYouTubeTranscriptFromAPI(
        videoId, pageData.innertubeContext, pageData.getTranscriptParams
      );
      if (transcript) return transcript;
    }

    throw new Error(
      getYouTubeTranscriptErrorMessage(panelResult?.error, pageData)
    );
  }

  function extractGmailEmail() {
    // Detect if viewing an individual email or thread.
    // Gmail hash patterns: #inbox/FMfcgz... or #sent/FMfcgz... for email views.
    const hash = window.location.hash;
    const isEmailView = /^#[a-z]+\/[A-Za-z0-9]/.test(hash);

    if (!isEmailView) {
      throw new Error('Please open an individual email to summarise it. Inbox and settings views are not supported.');
    }

    const subject = document.querySelector('h2[data-thread-perm-id]')?.textContent?.trim()
      || document.querySelector('h2.hP')?.textContent?.trim()
      || document.title.replace(/ - [^-]+@[^-]+ - Gmail$/, '').trim();

    if (!subject) {
      throw new Error('Could not find an email subject. Please make sure you have an email open.');
    }

    const sender = findGmailSender() || 'Unknown sender';

    // Extract email bodies — handle threads with multiple messages
    let bodyElements = document.querySelectorAll('.a3s.aiL');
    if (!bodyElements.length) {
      bodyElements = document.querySelectorAll('.ii.gt');
    }
    if (!bodyElements.length) {
      throw new Error('Could not extract email content. The email may still be loading—try again in a moment.');
    }

    const parts = [];
    bodyElements.forEach((body, index) => {
      const emailContainer = body.closest('.gs');
      let emailSender = sender;
      let emailDate = '';

      if (emailContainer) {
        const senderEl = emailContainer.querySelector('span.gD[name]');
        if (senderEl) emailSender = senderEl.getAttribute('name') || sender;
        const dateEl = emailContainer.querySelector('span.g3');
        if (dateEl) emailDate = dateEl.getAttribute('title') || dateEl.textContent || '';
      }

      const text = body.textContent?.trim();
      if (!text) return;

      if (bodyElements.length > 1) {
        parts.push('[Email ' + (index + 1) + ' from ' + emailSender + (emailDate ? ' on ' + emailDate : '') + ']\n' + text);
      } else {
        parts.push(text);
      }
    });

    const content = parts.join('\n\n---\n\n');
    if (!content) {
      throw new Error('Email content appears to be empty.');
    }

    const { wordCount, readingTimeMinutes } = calculateWordStats(content);

    return { title: subject, author: sender, content, wordCount, readingTimeMinutes };
  }

  return {
    calculateWordStats,
    extractArticle,
    findAuthor,
    cleanAuthorString,
    getDomainName,
    applySiteRules,
    extractYouTubeTranscript,
    extractGmailEmail,
  };

})();
