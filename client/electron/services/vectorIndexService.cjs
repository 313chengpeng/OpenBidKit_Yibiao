/**
 * 进程内向量索引（Brute-Force Cosine Similarity）
 *
 * 设计目标：
 * - 不引入任何 native 依赖，跨平台打包简单；
 * - 数据规模为万级以下时（典型知识库使用），余弦相似度的暴力检索足够；
 * - 支持按 documentIds 过滤、按 modelName 隔离；
 * - 全量加载 / 增量更新 / 删除文档三类操作。
 *
 * 复杂度：
 * - 加载 O(N)，单次检索 O(N * D)；N 文档块数，D 向量维度。
 * - 当 N > 50_000 或检索延迟成为瓶颈时，应替换为 HNSW / IVF 实现。
 */

function createVectorIndexService() {
  let entries = [];
  let indexByKey = new Map();

  function buildKey(documentId, chunkId, modelName) {
    return `${documentId}::${chunkId}::${modelName}`;
  }

  function clear() {
    entries = [];
    indexByKey = new Map();
  }

  function load(initialEntries) {
    clear();
    for (const entry of initialEntries) {
      upsert(entry);
    }
  }

  function upsert(entry) {
    if (!entry || !entry.documentId || !entry.chunkId || !entry.modelName) return;
    if (!Array.isArray(entry.vector) || !entry.vector.length) return;
    const key = buildKey(entry.documentId, entry.chunkId, entry.modelName);
    const normalized = normalizeEntry(entry);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      entries[existingIndex] = normalized;
    } else {
      indexByKey.set(key, entries.length);
      entries.push(normalized);
    }
  }

  function normalizeEntry(entry) {
    const vector = entry.vector.map((value) => Number(value));
    let norm = Number(entry.norm);
    if (!Number.isFinite(norm) || norm <= 0) {
      let sum = 0;
      for (const value of vector) sum += value * value;
      norm = Math.sqrt(sum) || 0;
    }
    return {
      documentId: String(entry.documentId),
      chunkId: String(entry.chunkId),
      chunkPk: Number(entry.chunkPk) || 0,
      modelName: String(entry.modelName),
      content: String(entry.content || ''),
      headingPath: Array.isArray(entry.headingPath) ? entry.headingPath : null,
      vector,
      norm,
    };
  }

  function removeDocument(documentId, modelName) {
    if (!documentId) return 0;
    const next = [];
    const nextIndex = new Map();
    for (const entry of entries) {
      if (entry.documentId === documentId && (!modelName || entry.modelName === modelName)) continue;
      nextIndex.set(buildKey(entry.documentId, entry.chunkId, entry.modelName), next.length);
      next.push(entry);
    }
    entries = next;
    indexByKey = nextIndex;
    return 0;
  }

  function size() {
    return entries.length;
  }

  function search({ vector, topK = 8, documentIds, modelName, minScore = 0 }) {
    if (!Array.isArray(vector) || !vector.length) return [];
    if (!entries.length) return [];

    const queryNorm = computeNorm(vector);
    if (queryNorm <= 0) return [];

    const filter = documentIds && documentIds.length
      ? new Set(documentIds.map((id) => String(id)))
      : null;

    const results = [];
    for (const entry of entries) {
      if (modelName && entry.modelName !== modelName) continue;
      if (filter && !filter.has(entry.documentId)) continue;
      const score = cosineSimilarity(vector, queryNorm, entry.vector, entry.norm);
      if (score < minScore) continue;
      results.push({
        documentId: entry.documentId,
        chunkId: entry.chunkId,
        chunkPk: entry.chunkPk,
        modelName: entry.modelName,
        content: entry.content,
        headingPath: entry.headingPath,
        score,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, topK));
  }

  function computeNorm(vector) {
    let sum = 0;
    for (const value of vector) sum += Number(value) * Number(value);
    return Math.sqrt(sum) || 0;
  }

  function cosineSimilarity(a, aNorm, b, bNorm) {
    if (!aNorm || !bNorm) return 0;
    const length = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < length; i += 1) {
      dot += Number(a[i]) * Number(b[i]);
    }
    return dot / (aNorm * bNorm);
  }

  return {
    load,
    upsert,
    removeDocument,
    clear,
    size,
    search,
  };
}

module.exports = { createVectorIndexService };
