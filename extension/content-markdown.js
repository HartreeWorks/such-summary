// Pure markdown/HTML utility functions used by the summariser UI.
// Loaded before content.js via chrome.scripting.executeScript.

window.SummarizerMarkdown = (() => {

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function processNestedBullets(summary) {
    const lines = summary.split('\n');
    const processedLines = [];
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Detect table start: header row followed by separator row
      if (!inTable && trimmedLine.includes('|') && trimmedLine.split('|').length >= 3 && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (/^[\s\-\|]+$/.test(nextLine) && nextLine.includes('|')) {
          inTable = true;
        }
      }

      // Inside a table — preserve line as-is, detect table end
      if (inTable) {
        processedLines.push(line);
        if (trimmedLine === '' || !trimmedLine.includes('|')) {
          inTable = false;
        }
        continue;
      }

      // Convert bullet points while preserving indentation
      const leadingSpaces = line.match(/^(\s*)/)[1].length;

      if (trimmedLine.startsWith('\u2022')) {
        processedLines.push(' '.repeat(leadingSpaces) + trimmedLine.replace('\u2022', '-'));
      } else {
        processedLines.push(line);
      }
    }

    return processedLines.join('\n');
  }

  // Escape lone tildes so "~340" stays literal while preserving "~~strikethrough~~".
  function escapeLiteralTildes(markdown) {
    if (typeof markdown !== 'string' || !markdown.includes('~')) {
      return markdown;
    }

    let output = '';
    for (let i = 0; i < markdown.length; i++) {
      const char = markdown[i];
      if (char !== '~') {
        output += char;
        continue;
      }

      const prevChar = i > 0 ? markdown[i - 1] : '';
      const nextChar = i < markdown.length - 1 ? markdown[i + 1] : '';

      if (prevChar !== '~' && nextChar !== '~') {
        output += '\\~';
      } else {
        output += '~';
      }
    }

    return output;
  }

  function convertTableToHTML(tableLines) {
    if (tableLines.length < 2) return tableLines.join('\n');

    let html = '<table class="ph-summarizer-table">\n';

    for (let i = 0; i < tableLines.length; i++) {
      const line = tableLines[i].trim();
      if (line === '') continue;

      // Skip separator lines
      if (/^[\s\-\|]+$/.test(line)) continue;

      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell !== '');

      if (cells.length === 0) continue;

      const tag = i === 0 ? 'th' : 'td';
      html += '  <tr>\n';

      for (const cell of cells) {
        html += `    <${tag}>${escapeHtml(cell)}</${tag}>\n`;
      }

      html += '  </tr>\n';
    }

    html += '</table>';
    return html;
  }

  // Manual table processing as fallback
  function processTablesManually(summary) {
    const lines = summary.split('\n');
    const processedLines = [];
    let inTable = false;
    let tableLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect table start
      if (line.includes('|') && line.split('|').length >= 3) {
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          const isSeparator = /^[\s\-\|]+$/.test(nextLine) && nextLine.includes('|');
          if (isSeparator) {
            inTable = true;
            tableLines = [lines[i], lines[i + 1]];
            i++; // Skip the separator line in the main loop
            continue;
          }
        }
      }

      // Collect table lines
      if (inTable && line.includes('|')) {
        tableLines.push(lines[i]);
      } else if (inTable) {
        // End of table, process it
        if (tableLines.length > 0) {
          processedLines.push(convertTableToHTML(tableLines));
          tableLines = [];
        }
        inTable = false;
        processedLines.push(lines[i]);
      } else {
        processedLines.push(lines[i]);
      }
    }

    // Handle table at the end
    if (tableLines.length > 0) {
      processedLines.push(convertTableToHTML(tableLines));
    }

    return processedLines.join('\n');
  }

  // Convert HTML element to markdown
  function htmlToMarkdown(element) {
    const processNode = (node, listDepth = 0) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }

      const tag = node.tagName.toLowerCase();
      let result = '';

      switch (tag) {
        case 'p':
          result = Array.from(node.childNodes).map(n => processNode(n, listDepth)).join('') + '\n\n';
          break;
        case 'ul':
          result = Array.from(node.children).map(li => processNode(li, listDepth)).join('');
          if (listDepth === 0) result += '\n';
          break;
        case 'ol': {
          let index = 1;
          result = Array.from(node.children).map(li => {
            const prefix = '  '.repeat(listDepth) + `${index++}. `;
            const content = Array.from(li.childNodes).map(n => processNode(n, listDepth + 1)).join('').trim();
            return prefix + content + '\n';
          }).join('');
          if (listDepth === 0) result += '\n';
          break;
        }
        case 'li': {
          const prefix = '  '.repeat(listDepth) + '- ';
          const content = Array.from(node.childNodes).map(n => processNode(n, listDepth + 1)).join('').trim();
          result = prefix + content + '\n';
          break;
        }
        case 'strong':
        case 'b':
          result = '**' + Array.from(node.childNodes).map(n => processNode(n, listDepth)).join('') + '**';
          break;
        case 'em':
        case 'i':
          result = '*' + Array.from(node.childNodes).map(n => processNode(n, listDepth)).join('') + '*';
          break;
        case 'blockquote': {
          const quoteContent = Array.from(node.childNodes).map(n => processNode(n, listDepth)).join('').trim();
          result = quoteContent.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
          break;
        }
        case 'br':
          result = '\n';
          break;
        default:
          result = Array.from(node.childNodes).map(n => processNode(n, listDepth)).join('');
      }

      return result;
    };

    const markdown = processNode(element);

    // Clean up extra whitespace
    return markdown.replace(/\n{3,}/g, '\n\n').trim();
  }

  return {
    escapeHtml,
    processNestedBullets,
    escapeLiteralTildes,
    processTablesManually,
    convertTableToHTML,
    htmlToMarkdown,
  };

})();
