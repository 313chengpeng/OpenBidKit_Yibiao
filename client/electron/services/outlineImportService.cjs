const fs = require('node:fs');
const path = require('node:path');

function loadElectron() {
  return require('electron');
}

const MAX_OUTLINE_LEVEL = 6;
const POINT_TO_POINT_PATTERN = /应答表|偏离表|点对点/;
const TEMPLATE_FILL_PATTERN = /格式|模板|一览表|报价表/;
const HEADING_NUMBER_PATTERN = /^(?:第[一二三四五六七八九十百千零0-9]+[章节条款部分篇]|[（(][一二三四五六七八九十百千零0-9]+[)）]|[一二三四五六七八九十百千]+、|[0-9]+(?:\.[0-9]+)*[、.．)]?\s+)/;

function inferContentMode(title) {
  const text = String(title || '');
  if (POINT_TO_POINT_PATTERN.test(text)) return 'point-to-point';
  if (TEMPLATE_FILL_PATTERN.test(text)) return 'template-fill';
  return 'ai-generate';
}

function stripHeadingNumber(title) {
  let next = String(title || '').replace(/\s+/g, ' ').trim();
  const stripped = next.replace(HEADING_NUMBER_PATTERN, '').trim();
  return stripped || next;
}

function isFenceLine(line) {
  return /^```/.test(String(line || '').trim());
}

function extractMarkdownHeadings(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  let inFence = false;
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const atx = /^(#{1,})(\s+.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      const rawLevel = atx[1].length;
      if (rawLevel > MAX_OUTLINE_LEVEL) truncated = true;
      headings.push({
        level: Math.min(rawLevel, MAX_OUTLINE_LEVEL),
        title: stripHeadingNumber(atx[2]),
      });
      continue;
    }

    const nextLine = lines[index + 1] || '';
    if (line.trim() && /^=+\s*$/.test(nextLine)) {
      headings.push({ level: 1, title: stripHeadingNumber(line) });
      index += 1;
      continue;
    }
    if (line.trim() && /^-+\s*$/.test(nextLine)) {
      headings.push({ level: 2, title: stripHeadingNumber(line) });
      index += 1;
    }
  }

  return { headings: headings.filter((item) => item.title), truncated };
}

function renumberImportedOutline(items, prefix = '') {
  return (items || []).map((item, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    const children = Array.isArray(item.children) && item.children.length
      ? renumberImportedOutline(item.children, id)
      : undefined;
    const next = {
      id,
      title: String(item.title || '').trim(),
      description: String(item.description || '').trim(),
    };
    if (children?.length) {
      next.children = children;
    } else {
      next.content_mode = item.content_mode || inferContentMode(item.title);
    }
    return next;
  });
}

function buildOutlineFromHeadings(headings) {
  const roots = [];
  const stack = [];

  for (const heading of headings) {
    const node = {
      title: heading.title,
      description: '',
      content_mode: inferContentMode(heading.title),
      children: [],
    };
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    if (!stack.length) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ level: heading.level, node });
  }

  const pruneEmptyChildren = (items) => items.map((item) => {
    const children = pruneEmptyChildren(item.children || []);
    if (children.length) {
      return { title: item.title, description: item.description, children };
    }
    return { title: item.title, description: item.description, content_mode: item.content_mode };
  });

  return renumberImportedOutline(pruneEmptyChildren(roots));
}

function parseOutlineFromMarkdown(markdown) {
  const { headings, truncated } = extractMarkdownHeadings(markdown);
  if (!headings.length) {
    return {
      success: false,
      message: '没有识别到可用标题。请使用 Word 标题样式或 Markdown 标题后再导入。',
      outline: [],
      warnings: [],
      truncated: false,
    };
  }

  const outline = buildOutlineFromHeadings(headings);
  const warnings = [];
  if (truncated) {
    warnings.push('超过 6 级的标题已截断为第 6 级。');
  }
  return {
    success: true,
    outline,
    warnings,
    truncated,
  };
}

function normalizeProvidedFilePaths(filePaths) {
  if (!Array.isArray(filePaths)) return [];
  return filePaths.map((item) => String(item || '').trim()).filter(Boolean);
}

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '项目简报';
}

async function exportMarkdownFile({ content, defaultFileName, title } = {}) {
  const markdown = String(content || '');
  if (!markdown.trim()) {
    return { success: false, message: '没有可导出的 Markdown 内容' };
  }
  const { app, dialog } = loadElectron();
  const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
  const fileName = sanitizeFilename(defaultFileName || '项目简报.md');
  const result = await dialog.showSaveDialog({
    title: title || '导出 Markdown',
    defaultPath: path.join(defaultDir, fileName.endsWith('.md') ? fileName : `${fileName}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true, message: '已取消导出' };
  }
  const outputPath = result.filePath.endsWith('.md') ? result.filePath : `${result.filePath}.md`;
  fs.writeFileSync(outputPath, markdown, 'utf8');
  return { success: true, path: outputPath, message: 'Markdown 已导出。' };
}

function createOutlineImportService({ configStore } = {}) {
  async function importOutlineDocument(filePaths) {
    const { parseDocumentWithConfig } = require('./fileService.cjs');
    const { app, dialog } = loadElectron();
    const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
    let selectedPaths = normalizeProvidedFilePaths(filePaths);
    if (selectedPaths.length > 1) selectedPaths = selectedPaths.slice(0, 1);

    if (!selectedPaths.length) {
      const result = await dialog.showOpenDialog({
        title: '选择目录文件',
        properties: ['openFile'],
        filters: [
          { name: 'Word / Markdown', extensions: ['docx', 'doc', 'md', 'markdown'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true, message: '已取消选择' };
      }
      selectedPaths = result.filePaths;
    }

    const filePath = selectedPaths[0];
    const fileName = path.basename(filePath);
    let markdown = '';
    try {
      markdown = (await parseDocumentWithConfig(app, filePath, config, {
        assetScope: 'outline-import',
        preserveImages: false,
      })).trim();
    } catch (error) {
      return { success: false, message: error.message || `解析 ${fileName} 失败`, fileName };
    }

    if (!markdown) {
      return { success: false, message: `${fileName} 未提取到有效内容`, fileName };
    }

    const parsed = parseOutlineFromMarkdown(markdown);
    if (!parsed.success) {
      return { ...parsed, fileName };
    }

    return {
      success: true,
      fileName,
      outline: parsed.outline,
      warnings: parsed.warnings,
      truncated: parsed.truncated,
      message: `已从 ${fileName} 识别 ${parsed.outline.length} 个一级目录`,
    };
  }

  return {
    importOutlineDocument,
    exportMarkdownFile,
  };
}

module.exports = {
  createOutlineImportService,
  inferContentMode,
  parseOutlineFromMarkdown,
  stripHeadingNumber,
};
