const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');

/**
 * RAG 文档处理默认参数。可被未来配置项覆盖。
 */
const RAG_DEFAULTS = {
  targetChunkChars: 800,         // 每块目标字符数（按非空白字符估算）
  overlapChars: 120,             // 块与块之间的重叠字符数
  minChunkChars: 120,            // 小于该字符数的尾部块不单独成块
  maxChunkChars: 1600,           // 单块字符上限，超出则强制切分
  sentenceEndPattern: /(?<=[。！？!?；;\n])\s*/g, // 切分优先点
};

function now() {
  return new Date().toISOString();
}

function safeName(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fromRelative(baseDir, relativePath) {
  return path.join(baseDir, relativePath || '');
}

function getContentCharCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function estimateTokenCount(text) {
  // 粗略估算：中文 1 字 ≈ 1.5 token，英文 1 word ≈ 1.3 token。
  const value = String(text || '');
  const chineseChars = (value.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = value.length - chineseChars;
  return Math.max(1, Math.round(chineseChars * 1.5 + otherChars * 0.5));
}

/**
 * 把 Markdown 正文切分为 RAG 检索用 chunk。
 * 切分策略：
 *   1. 先按 Markdown 标题分大段（保留 heading_path）；
 *   2. 在段内按目标字符数 + 重叠字符数切分；
 *   3. 尽量在句号/换行/段落边界附近切分。
 */
function chunkMarkdown(markdown, options = {}) {
  const target = Math.max(200, Number(options.targetChunkChars) || RAG_DEFAULTS.targetChunkChars);
  const overlap = Math.max(0, Math.min(target / 2, Number(options.overlapChars) || RAG_DEFAULTS.overlapChars));
  const minChunk = Math.max(40, Number(options.minChunkChars) || RAG_DEFAULTS.minChunkChars);
  const maxChunk = Math.max(target, Number(options.maxChunkChars) || RAG_DEFAULTS.maxChunkChars);

  const segments = splitByHeadings(markdown);
  const chunks = [];
  let chunkIndex = 0;

  for (const segment of segments) {
    const text = segment.content;
    if (!text || !text.trim()) continue;
    const charCount = getContentCharCount(text);
    if (charCount <= maxChunk && charCount <= target * 1.5) {
      chunks.push(makeChunk(segment.headingPath, text, chunkIndex));
      chunkIndex += 1;
      continue;
    }
    const pieces = splitTextBySize(text, target, overlap, minChunk, maxChunk);
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      chunks.push(makeChunk(segment.headingPath, piece, chunkIndex));
      chunkIndex += 1;
    }
  }

  return chunks;
}

function splitByHeadings(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const segments = [];
  const headings = [];
  let buffer = [];

  function flush() {
    const content = buffer.join('\n').trim();
    if (content) {
      segments.push({ headingPath: [...headings], content });
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      headings.splice(level - 1);
      headings[level - 1] = headingMatch[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (!segments.length) {
    segments.push({ headingPath: [], content: String(markdown || '').trim() });
  }
  return segments;
}

function splitTextBySize(text, target, overlap, minChunk, maxChunk) {
  const value = String(text || '');
  if (getContentCharCount(value) <= maxChunk) {
    return [value.trim()].filter(Boolean);
  }
  // 在目标位置附近找最近的句子边界
  const out = [];
  let cursor = 0;
  while (cursor < value.length) {
    const idealEnd = Math.min(value.length, cursor + target);
    let end = idealEnd;
    if (end < value.length) {
      const searchEnd = Math.min(value.length, end + Math.floor((maxChunk - target) / 2));
      for (let i = end; i < searchEnd; i += 1) {
        const ch = value[i];
        if (ch && /[。！？!?；;\n]/.test(ch)) {
          end = i + 1;
          break;
        }
      }
    }
    const piece = value.slice(cursor, end).trim();
    if (piece.length >= minChunk || !out.length) {
      out.push(piece);
    } else if (out.length) {
      out[out.length - 1] = `${out[out.length - 1]}\n${piece}`.trim();
    }
    if (end >= value.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

function makeChunk(headingPath, content, index) {
  const id = `C${String(index + 1).padStart(6, '0')}`;
  return {
    chunk_id: id,
    heading_path: Array.isArray(headingPath) ? headingPath.filter(Boolean) : [],
    content: String(content || '').trim(),
    content_chars: getContentCharCount(content),
    token_estimate: estimateTokenCount(content),
  };
}

function createRagService({ app, knowledgeBaseStore, embeddingService, vectorIndexService }) {
  const baseDir = getKnowledgeBaseDir(app);

  const documentEmbeddings = new Map(); // documentId -> {modelName, dimensions, embeddingUpdatedAt}
  const activePreparations = new Set();
  const activeEmbeddings = new Set();

  if (!knowledgeBaseStore) {
    throw new Error('知识库数据库服务尚未初始化');
  }
  if (!embeddingService) {
    throw new Error('Embedding 服务尚未初始化');
  }
  if (!vectorIndexService) {
    throw new Error('向量索引服务尚未初始化');
  }

  function debugLog(documentId, event, payload = {}) {
    try {
      const logDir = path.join(app?.getPath('userData') || '', 'logs', 'knowledge-base-rag');
      ensureDir(logDir);
      const entry = { time: now(), documentId, event, ...payload };
      fs.appendFileSync(path.join(logDir, `${safeName(documentId)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {}
  }

  function emitProgress(webContents, document) {
    if (!webContents?.isDestroyed()) {
      webContents.send('knowledge-base:event', { document });
    }
  }

  function readDocumentMarkdown(document) {
    const markdownPath = fromRelative(baseDir, document.markdown_path);
    if (!fs.existsSync(markdownPath)) return '';
    return fs.readFileSync(markdownPath, 'utf-8').trim();
  }

  function getEmbeddingConfig() {
    const document = knowledgeBaseStore.getRagConfig();
    return {
      modelName: document.embeddingModel,
      dimensions: document.embeddingDimensions,
    };
  }

  async function buildChunksForDocument(document) {
    const markdown = readDocumentMarkdown(document);
    if (!markdown) {
      throw new Error('未找到 Markdown 原文，请重新上传');
    }
    const chunks = chunkMarkdown(markdown);
    if (!chunks.length) {
      throw new Error('文档未切分出任何 RAG chunk');
    }
    knowledgeBaseStore.saveRagChunks(document.id, chunks);
    debugLog(document.id, 'chunks:built', { chunk_count: chunks.length });
    return chunks;
  }

  async function embedChunksForDocument(document, webContents) {
    const chunks = knowledgeBaseStore.readRagChunks(document.id);
    if (!chunks.length) throw new Error('未找到待嵌入的 chunk，请先完成切分');

    const texts = chunks.map((chunk) => {
      const heading = chunk.heading_path?.length ? `${chunk.heading_path.join(' > ')}\n` : '';
      return `${heading}${chunk.content}`;
    });
    const total = texts.length;
    debugLog(document.id, 'embedding:start', { chunk_count: total, chars: texts.reduce((s, t) => s + t.length, 0) });

    let processed = 0;
    const vectors = await embeddingService.embedBatch(texts, {
      logTitle: `rag-${safeName(document.file_name)}`,
      onProgress({ batchIndex, batchCount, completed }) {
        processed = completed;
        const progress = Math.min(95, 70 + Math.round((completed / Math.max(total, 1)) * 25));
        emitProgress(webContents, knowledgeBaseStore.updateDocument(document.id, {
          status: 'embedding',
          progress,
          message: `正在生成向量 ${completed}/${total}（第 ${batchIndex}/${batchCount} 批）`,
          chunk_count: total,
          embedded_chunk_count: completed,
        }));
      },
    });

    if (vectors.length !== chunks.length) {
      throw new Error(`Embedding 返回数量(${vectors.length})与 chunk 数(${chunks.length})不一致`);
    }
    const { model_name, dimensions } = getEmbeddingConfig();
    const records = chunks.map((chunk, index) => ({
      chunk_id: chunk.chunk_id,
      chunk_pk: chunk.id,
      document_id: document.id,
      model_name,
      dimensions: vectors[index].length,
      vector: vectors[index],
      content: chunk.content,
      heading_path: chunk.heading_path,
    }));
    knowledgeBaseStore.saveRagEmbeddings(document.id, model_name, records, dimensions);
    documentEmbeddings.set(document.id, { modelName: model_name, dimensions, embeddingUpdatedAt: now() });
    debugLog(document.id, 'embedding:done', { chunk_count: total, model: model_name, dimensions });

    // 增量更新进程内索引
    for (const record of records) {
      vectorIndexService.upsert({
        documentId: record.document_id,
        chunkId: record.chunk_id,
        chunkPk: record.chunk_pk,
        modelName: record.model_name,
        vector: record.vector,
        content: record.content,
        headingPath: record.heading_path,
      });
    }
  }

  function loadIndexFromStore() {
    const rows = knowledgeBaseStore.readAllRagEmbeddings();
    vectorIndexService.load(rows);
    return { count: rows.length };
  }

  function isDocumentReadyForEmbedding(document) {
    return document && document.status !== 'pending' && document.status !== 'copying' && document.status !== 'converting';
  }

  async function prepareRagDocument(documentId, sourceFilePath, webContents) {
    if (activePreparations.has(documentId)) {
      debugLog(documentId, 'prepare:skip-active');
      return;
    }
    activePreparations.add(documentId);
    debugLog(documentId, 'prepare:start', { source_file_path: sourceFilePath });

    try {
      const document = knowledgeBaseStore.getDocument(documentId);
      if (!document) throw new Error('文档不存在');
      const documentDir = fromRelative(baseDir, document.document_dir);
      const sourcePath = fromRelative(baseDir, document.source_path);
      const markdownPath = fromRelative(baseDir, document.markdown_path);
      ensureDir(documentDir);

      // 1. 复制 source
      if (!fs.existsSync(sourcePath)) {
        if (!fs.existsSync(sourceFilePath)) {
          throw new Error('原始文件不存在，请重新上传');
        }
        await fsp.copyFile(sourceFilePath, sourcePath);
      }

      // 2. 转换 Markdown（如尚未生成）
      let markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8').trim() : '';
      if (!markdown) {
        const config = knowledgeBaseStore.getFileParserConfig();
        const { parseDocumentWithConfig } = require('./fileService.cjs');
        const parsed = (await parseDocumentWithConfig(app, sourcePath, config, {
          assetScope: `knowledge-${documentId}`,
          preserveImages: false,
        })).trim();
        if (!parsed) throw new Error('文档未解析出有效 Markdown 内容');
        await fsp.writeFile(markdownPath, `${parsed}\n`, 'utf-8');
        markdown = parsed;
        knowledgeBaseStore.updateMarkdownMetadata(documentId, parsed);
      }
      debugLog(documentId, 'prepare:markdown-ready', { markdown_chars: markdown.length });

      // 3. 切分 chunk
      const existingChunks = knowledgeBaseStore.readRagChunks(documentId);
      if (existingChunks.length) {
        debugLog(documentId, 'prepare:reuse-chunks', { chunk_count: existingChunks.length });
      } else {
        emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
          status: 'chunking',
          progress: 35,
          message: '正在切分 RAG chunk',
          chunk_count: 0,
          embedded_chunk_count: 0,
          error: null,
        }));
        const built = await buildChunksForDocument(document);
        emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
          status: 'chunking',
          progress: 55,
          message: `已切分 ${built.length} 个 chunk`,
          chunk_count: built.length,
        }));
      }

      // 4. Embedding
      await embedChunksForDocument(knowledgeBaseStore.getDocument(documentId), webContents);

      emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
        status: 'success',
        progress: 100,
        message: 'RAG 索引完成',
      }));
    } catch (error) {
      debugLog(documentId, 'prepare:error', { message: error.message || String(error) });
      emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
        status: 'error',
        progress: 100,
        message: error.message || 'RAG 处理失败',
        error: error.message || 'RAG 处理失败',
      }));
    } finally {
      activePreparations.delete(documentId);
      activeEmbeddings.delete(documentId);
    }
  }

  async function reembedDocument(documentId, webContents) {
    if (activeEmbeddings.has(documentId)) {
      return { success: false, message: '该文档正在重新嵌入中' };
    }
    activeEmbeddings.add(documentId);
    try {
      const document = knowledgeBaseStore.getDocument(documentId);
      if (!document) throw new Error('文档不存在');
      vectorIndexService.removeDocument(documentId);
      knowledgeBaseStore.clearRagEmbeddings(documentId);
      await embedChunksForDocument(document, webContents);
      emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
        status: 'success',
        progress: 100,
        message: 'RAG 索引已更新',
      }));
      return { success: true, message: 'RAG 索引已更新' };
    } catch (error) {
      emitProgress(webContents, knowledgeBaseStore.updateDocument(documentId, {
        status: 'error',
        progress: 100,
        message: error.message || '重新嵌入失败',
        error: error.message || '重新嵌入失败',
      }));
      return { success: false, message: error.message || '重新嵌入失败' };
    } finally {
      activeEmbeddings.delete(documentId);
    }
  }

  async function search(query, options = {}) {
    const { documentIds, topK = 8, modelName, minScore = 0 } = options || {};
    const text = String(query || '').trim();
    if (!text) return [];
    const embedding = await embeddingService.embedOne(text, { logTitle: 'rag-search' });
    if (modelName && embedding.model !== modelName) {
      // 跨模型检索意义不大，给出空结果
      return [];
    }
    return vectorIndexService.search({
      vector: embedding.vector,
      topK,
      documentIds,
      modelName: embedding.model,
      minScore,
    });
  }

  function getActiveDocumentIds() {
    return [...new Set([...activePreparations, ...activeEmbeddings])];
  }

  return {
    chunkMarkdown,
    buildChunksForDocument,
    embedChunksForDocument,
    prepareRagDocument,
    reembedDocument,
    search,
    loadIndexFromStore,
    getActiveDocumentIds,
  };
}

module.exports = { createRagService, chunkMarkdown, RAG_DEFAULTS };
