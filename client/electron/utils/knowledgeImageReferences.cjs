'use strict';

const path = require('node:path');

/**
 * 企业图片知识库 `kbimg:<imageId>` 引用解析工具（纯 Main 侧，无数据库/文件系统依赖）。
 *
 * 约定：
 * - 正文 Markdown 中企业图片一律写作 `![名称](kbimg:<imageId>)`；
 * - 普通 URL / data URL 图片不经过本模块处理；
 * - 工具只做文本替换与路径边界校验，不读取数据库，也不修改正文持久化值。
 */

// 匹配完整的 Markdown 图片语法 ![alt](kbimg:id)；id 仅允许字母、数字、下划线和短横线
const KNOWLEDGE_IMAGE_REFERENCE_PATTERN = /!\[([^\]]*)\]\(kbimg:([A-Za-z0-9_-]+)\)/g;

/** 从 Markdown 中提取按出现顺序去重后的企业图片 ID 列表 */
function extractKnowledgeImageIds(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return [];
  }
  const seen = new Set();
  const ids = [];
  for (const match of markdown.matchAll(KNOWLEDGE_IMAGE_REFERENCE_PATTERN)) {
    const id = match[2];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 将正文中所有 `![名称](kbimg:<id>)` 引用替换为 resolver 返回的 URL/路径。
 *
 * resolver 返回 null/undefined/空字符串时，整个图片引用替换为 `[图片已失效：<id>]` 占位文本。
 * 每个 ID 只调用一次 resolver（去重读取），返回值：
 * - content: 替换后的 Markdown
 * - imageIds: 出现过的全部 ID（按首次出现顺序）
 * - missingImageIds: resolver 未解析成功的 ID
 */
async function replaceKnowledgeImageReferences(markdown, resolver) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { content: markdown ?? '', imageIds: [], missingImageIds: [] };
  }
  const imageIds = extractKnowledgeImageIds(markdown);
  if (imageIds.length === 0) {
    return { content: markdown, imageIds: [], missingImageIds: [] };
  }

  // 每个唯一 ID 只读取一次，失败缓存为 null，避免重复读取已失效图片
  const resolvedById = new Map();
  const missingImageIds = [];
  for (const imageId of imageIds) {
    const resolved = resolver ? await resolver(imageId) : null;
    if (typeof resolved === 'string' && resolved.length > 0) {
      resolvedById.set(imageId, resolved);
    } else {
      resolvedById.set(imageId, null);
      missingImageIds.push(imageId);
    }
  }

  // replace 的 replacer 函数返回值按字面插入，resolver 返回值中的 $& 等字符不会被解释
  const content = markdown.replace(KNOWLEDGE_IMAGE_REFERENCE_PATTERN, (_reference, altText, imageId) => {
    const resolved = resolvedById.get(imageId);
    if (!resolved) {
      return `[图片已失效：${imageId}]`;
    }
    return `![${altText}](${resolved})`;
  });

  return { content, imageIds, missingImageIds };
}

/**
 * 校验候选路径是否位于 scope root（图片库目录）之内，越界返回 null。
 * 仅接受 Main 侧生成的绝对路径，防止路径穿越。
 */
function resolveScopedImagePath(candidatePath, scopeRoot) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
    return null;
  }
  if (typeof scopeRoot !== 'string' || scopeRoot.length === 0) {
    return null;
  }
  const root = path.resolve(scopeRoot);
  // Main 生成的合法路径不会包含 .. 段；出现即视为可疑输入，直接拒绝
  const hasParentSegment = candidatePath
    .split(/[\\/]+/)
    .some((segment) => segment === '..');
  if (hasParentSegment) {
    return null;
  }
  const resolved = path.resolve(root, candidatePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

module.exports = {
  extractKnowledgeImageIds,
  replaceKnowledgeImageReferences,
  resolveScopedImagePath,
};
