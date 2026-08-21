function convertChineseQuotes(value) {
  let result = '';
  let doubleOpen = true;
  let singleOpen = true;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      result += doubleOpen ? '“' : '”';
      doubleOpen = !doubleOpen;
      continue;
    }
    if (char === "'") {
      const prev = text[index - 1] || '';
      const next = text[index + 1] || '';
      if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) {
        result += char;
        continue;
      }
      result += singleOpen ? '‘' : '’';
      singleOpen = !singleOpen;
      continue;
    }
    result += char;
  }
  return result;
}

function stripChineseSpaces(value) {
  return String(value || '').replace(/([\u3400-\u9FFF\uF900-\uFAFF])[ \t]+(?=[\u3400-\u9FFF\uF900-\uFAFF])/g, '$1');
}

function applyTextNormalization(value, options) {
  if (!options?.chinese_quotes && !options?.strip_spaces) return String(value || '');
  let text = String(value || '');
  if (options.chinese_quotes) text = convertChineseQuotes(text);
  if (options.strip_spaces) text = stripChineseSpaces(text);
  return text;
}

function protectMarkdownMarkup(markdown, stash) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash)
    .replace(/<\/?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>/g, stash)
    .replace(/<https?:[^>\s]+>/gi, stash)
    .replace(/\]\((?:<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g, stash)
    .replace(/^\s*\[[^\]]+\]:\s+(?:<[^>\n]+>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm, stash);
}

function applyTextNormalizationToMarkdown(markdown, options) {
  if (!options?.chinese_quotes && !options?.strip_spaces) return String(markdown || '');
  const preserved = [];
  const protectedText = protectMarkdownMarkup(markdown, (block) => {
    preserved.push(block);
    return `\0FENCE${preserved.length - 1}\0`;
  });
  return applyTextNormalization(protectedText, options).replace(/\0FENCE(\d+)\0/g, (_, index) => preserved[Number(index)] || '');
}

module.exports = {
  applyTextNormalization,
  applyTextNormalizationToMarkdown,
  convertChineseQuotes,
  stripChineseSpaces,
};
