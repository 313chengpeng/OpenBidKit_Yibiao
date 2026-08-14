const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_QUERY_LENGTH = 190;
const DEFAULT_MAX_QUERY_COUNT = 6;
const DEFAULT_MAX_RESULTS = 60;
const RETRIEVAL_CONCURRENCY = 4;
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
    timeoutMs: Math.max(1_000, Number.parseInt(read('DIFY_REQUEST_TIMEOUT_MS'), 10) || DEFAULT_TIMEOUT_MS),
  };
}

function splitQueryLine(value) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  if (!line) return [];

  const labelMatch = /^([^：:]{1,16}[：:])/.exec(line);
  const prefix = labelMatch?.[1] || '';
  const body = prefix ? line.slice(prefix.length).trim() : line;
  const bodyLimit = Math.max(1, MAX_QUERY_LENGTH - prefix.length);
  if (!body) return [prefix.slice(0, MAX_QUERY_LENGTH)];

  const units = body.match(/[^。！？；;!?]+[。！？；;!?]?/gu) || [body];
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(`${prefix}${current}`.slice(0, MAX_QUERY_LENGTH));
    current = '';
  };

  for (const rawUnit of units) {
    let unit = String(rawUnit || '').trim();
    if (!unit) continue;

    while (unit.length > bodyLimit) {
      pushCurrent();
      chunks.push(`${prefix}${unit.slice(0, bodyLimit)}`.slice(0, MAX_QUERY_LENGTH));
      unit = unit.slice(bodyLimit).trim();
    }

    if (!unit) continue;
    const separator = current ? ' ' : '';
    if (current.length + separator.length + unit.length <= bodyLimit) {
      current = `${current}${separator}${unit}`;
    } else {
      pushCurrent();
      current = unit;
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

function buildRetrievalQueries(value, maxQueries = DEFAULT_MAX_QUERY_COUNT) {
  const limit = Math.max(1, Math.min(12, Number(maxQueries) || DEFAULT_MAX_QUERY_COUNT));
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const groups = (lines.length ? lines : [value])
    .map(splitQueryLine)
    .filter((group) => group.length);
  const queries = [];
  const seen = new Set();

  for (let index = 0; queries.length < limit; index += 1) {
    let added = false;
    for (const group of groups) {
      const query = group[index];
      if (!query) continue;
      added = true;
      if (!seen.has(query)) {
        seen.add(query);
        queries.push(query);
        if (queries.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return queries;
}

function normalizeQuery(value) {
  return buildRetrievalQueries(value, 1)[0] || '';
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
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
    authority: 'reference',
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
      const payload = await request(`/datasets?page=${page}&limit=100&include_all=true`);
      datasets.push(...(Array.isArray(payload?.data) ? payload.data : []));
      hasMore = Boolean(payload?.has_more);
      page += 1;
    }
    return {
      configured: true,
      datasets: datasets
        .map(normalizeDataset)
        .filter((dataset) => dataset.id)
        .sort((left, right) => Number(right.enable_api) - Number(left.enable_api) || left.name.localeCompare(right.name, 'zh-CN')),
    };
  }

  async function retrieve(datasetIds, query, options = {}) {
    const ids = [...new Set((Array.isArray(datasetIds) ? datasetIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const queries = buildRetrievalQueries(query, options.maxQueries);
    if (!queries.length) return [];
    const maxResults = Math.max(1, Math.min(200, Number(options.maxResults) || DEFAULT_MAX_RESULTS));
    options.onQueryPlan?.({
      queryCount: queries.length,
      requestCount: queries.length * ids.length,
      maxQueryLength: Math.max(...queries.map((item) => item.length)),
    });
    const requests = queries.flatMap((item) => ids.map((datasetId) => ({ datasetId, query: item })));
    const results = await mapWithConcurrency(requests, RETRIEVAL_CONCURRENCY, async ({ datasetId, query: retrievalQuery }) => {
      try {
        const payload = await request(`/datasets/${encodeURIComponent(datasetId)}/retrieve`, {
          method: 'POST',
          body: JSON.stringify({ query: retrievalQuery }),
        });
        const items = (Array.isArray(payload?.records) ? payload.records : [])
          .map((record) => normalizeRecord(datasetId, record))
          .filter(Boolean);
        options.onQueryResult?.({ datasetId, queryLength: retrievalQuery.length, hitCount: items.length });
        return { ok: true, datasetId, items };
      } catch (error) {
        options.onQueryError?.({ datasetId, queryLength: retrievalQuery.length, error });
        return { ok: false, datasetId, items: [], error };
      }
    });
    const successful = results.filter((result) => result.ok);
    if (!successful.length && results.length) {
      throw results.find((result) => result.error)?.error || new Error('Dify 检索失败');
    }

    const fused = new Map();
    for (const result of successful) {
      result.items.forEach((item, rank) => {
        const fingerprint = crypto.createHash('sha256').update(item.content, 'utf-8').digest('hex');
        const existing = fused.get(fingerprint);
        const fusionScore = (existing?.fusion_score || 0) + (1 / (60 + rank + 1));
        const datasetIdsForItem = new Set(existing?.dataset_ids || []);
        datasetIdsForItem.add(item.dataset_id);
        const bestItem = !existing || Number(item.score || 0) > Number(existing.score || 0) ? item : existing;
        fused.set(fingerprint, {
          ...bestItem,
          dataset_ids: [...datasetIdsForItem],
          fusion_score: fusionScore,
        });
      });
    }
    return [...fused.values()]
      .sort((left, right) => Number(right.fusion_score || 0) - Number(left.fusion_score || 0)
        || Number(right.score || 0) - Number(left.score || 0))
      .slice(0, maxResults);
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
    buildRetrievalQueries,
    normalizeQuery,
    normalizeRecord,
  },
};
