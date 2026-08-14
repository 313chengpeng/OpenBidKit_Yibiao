const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_QUERY_LENGTH = 250;
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

function parseEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const result = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function getEnvCandidates(app) {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '..', '.env'),
  ];
  try {
    const appPath = app?.getAppPath?.();
    if (appPath) {
      candidates.push(path.join(appPath, '.env'), path.join(appPath, '..', '.env'));
    }
  } catch {
    // 忽略不可用的 Electron appPath。
  }
  try {
    const executablePath = app?.getPath?.('exe');
    if (executablePath) candidates.push(path.join(path.dirname(executablePath), '.env'));
  } catch {
    // 忽略不可用的可执行文件路径。
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function loadDifyEnv(app) {
  const fileValues = {};
  for (const candidate of getEnvCandidates(app)) {
    Object.assign(fileValues, parseEnvFile(candidate));
  }
  const read = (key) => String(process.env[key] ?? fileValues[key] ?? '').trim();
  return {
    apiBaseUrl: read('DIFY_API_BASE_URL').replace(/\/+$/, ''),
    apiKey: read('DIFY_KNOWLEDGE_API_KEY'),
    topK: Math.max(1, Math.min(20, Number.parseInt(read('DIFY_RETRIEVAL_TOP_K'), 10) || DEFAULT_TOP_K)),
    timeoutMs: Math.max(1_000, Number.parseInt(read('DIFY_REQUEST_TIMEOUT_MS'), 10) || DEFAULT_TIMEOUT_MS),
  };
}

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

function summaryFromContent(content) {
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function normalizeDataset(dataset) {
  return {
    id: String(dataset?.id || '').trim(),
    name: String(dataset?.name || '').trim(),
    description: String(dataset?.description || '').trim(),
    document_count: Number(dataset?.document_count ?? dataset?.total_documents ?? 0),
    word_count: Number(dataset?.word_count || 0),
    enable_api: dataset?.enable_api !== false,
  };
}

function normalizeRecord(datasetId, record) {
  const segment = record?.segment || {};
  const document = segment?.document || {};
  const segmentId = String(segment.id || '').trim();
  const documentId = String(segment.document_id || document.id || '').trim();
  const content = String(segment.content || '').trim();
  if (!segmentId || !content) return null;
  return {
    id: `dify::${datasetId}::${documentId || 'unknown'}::${segmentId}`,
    provider: 'dify',
    dataset_id: datasetId,
    document_id: documentId,
    segment_id: segmentId,
    title: String(document.name || 'Dify 知识片段').trim(),
    resume: summaryFromContent(record?.summary?.content || record?.summary || content),
    content,
    score: Number.isFinite(Number(record?.score)) ? Number(record.score) : undefined,
  };
}

function createDifyKnowledgeService({ app }) {
  function getConfig() {
    const config = loadDifyEnv(app);
    if (!config.apiBaseUrl) {
      throw new Error('Dify 未配置：请在 .env 中填写 DIFY_API_BASE_URL');
    }
    if (!/^https?:\/\//i.test(config.apiBaseUrl)) {
      throw new Error('DIFY_API_BASE_URL 必须是 http:// 或 https:// 地址');
    }
    if (!config.apiKey) {
      throw new Error('Dify 未配置：请在 .env 中填写 DIFY_KNOWLEDGE_API_KEY');
    }
    return config;
  }

  async function request(endpoint, options = {}) {
    const config = getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.apiBaseUrl}${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message = payload?.message || payload?.error || text || `HTTP ${response.status}`;
        throw new Error(`Dify 请求失败（${response.status}）：${message}`);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Dify 请求超时（${config.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listDatasets() {
    const datasets = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const payload = await request(`/datasets?page=${page}&limit=100`);
      datasets.push(...(Array.isArray(payload?.data) ? payload.data : []));
      hasMore = Boolean(payload?.has_more);
      page += 1;
    }
    return {
      configured: true,
      datasets: datasets.map(normalizeDataset).filter((dataset) => dataset.id && dataset.enable_api),
    };
  }

  async function retrieve(datasetIds, query, options = {}) {
    const ids = [...new Set((Array.isArray(datasetIds) ? datasetIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const config = getConfig();
    const topK = Math.max(1, Math.min(20, Number(options.topK) || config.topK));
    const results = await Promise.all(ids.map(async (datasetId) => {
      const payload = await request(`/datasets/${encodeURIComponent(datasetId)}/retrieve`, {
        method: 'POST',
        body: JSON.stringify({
          query: normalizedQuery,
          retrieval_model: {
            top_k: topK,
            score_threshold_enabled: false,
          },
        }),
      });
      return (Array.isArray(payload?.records) ? payload.records : [])
        .map((record) => normalizeRecord(datasetId, record))
        .filter(Boolean);
    }));
    const seen = new Set();
    return results.flat()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .filter((item) => {
        const fingerprint = crypto.createHash('sha256').update(item.content, 'utf-8').digest('hex');
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      });
  }

  function getStatus() {
    const config = loadDifyEnv(app);
    return {
      configured: Boolean(config.apiBaseUrl && config.apiKey),
      apiBaseUrl: config.apiBaseUrl,
    };
  }

  return {
    getStatus,
    listDatasets,
    retrieve,
  };
}

module.exports = {
  createDifyKnowledgeService,
  _internals: {
    loadDifyEnv,
    normalizeQuery,
    normalizeRecord,
  },
};
