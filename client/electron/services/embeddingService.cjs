const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAiLogsDir } = require('../utils/paths.cjs');
const { createDeveloperLogger } = require('../utils/developerLog.cjs');

const EMBEDDING_REQUEST_TIMEOUT_MS = 120000;
const MAX_LOG_TITLE_LENGTH = 64;

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function sanitizeLogTitle(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LOG_TITLE_LENGTH)
    .replace(/[. ]+$/g, '');
}

function createRequestId() {
  return `embedding-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function buildEmbeddingEndpoint(baseUrl) {
  const trimmed = trimBaseUrl(baseUrl);
  if (!trimmed) throw new Error('Embedding 服务 Base URL 不能为空');
  return `${trimmed}/embeddings`;
}

async function postJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function readErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (payload.error?.message) return String(payload.error.message);
  if (payload.message) return String(payload.message);
  return fallback;
}

function parseEmbeddingResponse(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (!data.length) throw new Error('Embedding 服务未返回任何向量');
  return data.map((item, index) => {
    const vector = Array.isArray(item?.embedding) ? item.embedding.map((value) => Number(value)) : null;
    if (!vector || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding 服务第 ${index + 1} 条返回的向量无效`);
    }
    return vector;
  });
}

function createEmbeddingService({ app, configStore }) {
  const debugLog = createDeveloperLogger({
    app,
    logDirName: 'embedding',
    consolePrefix: '[embedding]',
  });

  function loadConfig() {
    if (!configStore) throw new Error('配置服务尚未初始化');
    const fullConfig = configStore.load();
    const embedding = fullConfig.embedding_model;
    if (!embedding) throw new Error('未配置 Embedding 模型，请先在「设置」中填写');
    if (!embedding.api_key) throw new Error('Embedding 模型 API Key 未填写');
    if (!embedding.model_name) throw new Error('Embedding 模型名称未填写');
    return embedding;
  }

  function normalizeVector(vector) {
    if (!Array.isArray(vector)) throw new Error('Embedding 向量格式无效');
    let sum = 0;
    for (const value of vector) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('Embedding 向量包含非数值');
      sum += n * n;
    }
    return { vector, norm: Math.sqrt(sum) || 0 };
  }

  function serializeVector(vector) {
    const buffer = Buffer.alloc(vector.length * 4);
    for (let i = 0; i < vector.length; i += 1) {
      buffer.writeFloatLE(Number(vector[i]), i * 4);
    }
    return buffer;
  }

  function deserializeVector(buffer, dimensions) {
    if (!buffer || buffer.length !== dimensions * 4) {
      throw new Error('Embedding 向量字节长度与维度不匹配');
    }
    const vector = new Array(dimensions);
    for (let i = 0; i < dimensions; i += 1) {
      vector[i] = buffer.readFloatLE(i * 4);
    }
    return vector;
  }

  function writeAiLog(payload) {
    if (!app) return;
    const fullConfig = (() => {
      try { return configStore?.load() || {}; } catch { return {}; }
    })();
    if (!fullConfig.developer_mode) return;
    try {
      const logsDir = getAiLogsDir(app);
      fs.mkdirSync(path.join(logsDir, 'embedding'), { recursive: true });
      const logTitle = sanitizeLogTitle(payload.log_title);
      const fileName = `${payload.request_id}${logTitle ? `-${logTitle}` : ''}.json`;
      fs.writeFileSync(path.join(logsDir, 'embedding', fileName), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      debugLog.warn('写入 embedding 日志失败', { message: error.message });
    }
  }

  async function requestEmbeddings(inputTexts, options = {}) {
    const texts = (Array.isArray(inputTexts) ? inputTexts : [inputTexts])
      .map((text) => String(text || '').trim())
      .filter(Boolean);
    if (!texts.length) return { vectors: [], model: '', dimensions: 0 };

    const config = loadConfig();
    const endpoint = buildEmbeddingEndpoint(config.base_url);
    const body = {
      model: config.model_name,
      input: texts,
    };
    if (config.dimensions && Number.isFinite(Number(config.dimensions)) && Number(config.dimensions) > 0) {
      body.dimensions = Number(config.dimensions);
    }
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    };
    const requestId = options.requestId || createRequestId();
    const logPayload = {
      request_id: requestId,
      time: new Date().toISOString(),
      log_title: options.logTitle || 'embedding',
      endpoint,
      model: config.model_name,
      input_count: texts.length,
      input_chars: texts.reduce((sum, text) => sum + text.length, 0),
    };

    let response;
    try {
      response = await postJsonWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, EMBEDDING_REQUEST_TIMEOUT_MS);
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? 'Embedding 服务请求超时'
        : `Embedding 服务请求失败：${error.message || String(error)}`;
      logPayload.error = message;
      writeAiLog(logPayload);
      throw new Error(message);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        logPayload.error = `Embedding 响应不是合法 JSON：${error.message}`;
        logPayload.response_preview = text.slice(0, 500);
        writeAiLog(logPayload);
        throw new Error('Embedding 服务返回了非 JSON 响应');
      }
    }

    if (!response.ok) {
      const message = readErrorMessage(payload, `Embedding 服务返回 HTTP ${response.status}`);
      logPayload.status = response.status;
      logPayload.error = message;
      logPayload.response_preview = text.slice(0, 500);
      writeAiLog(logPayload);
      throw new Error(message);
    }

    const rawVectors = parseEmbeddingResponse(payload);
    const normalized = rawVectors.map((vector) => normalizeVector(vector).vector);
    const dimensions = normalized[0]?.length || 0;
    if (config.dimensions && Number(config.dimensions) > 0 && dimensions !== Number(config.dimensions)) {
      debugLog.warn('Embedding 维度与配置不一致', { configured: config.dimensions, actual: dimensions });
    }

    logPayload.status = response.status;
    logPayload.usage = payload?.usage || null;
    logPayload.dimensions = dimensions;
    writeAiLog(logPayload);

    return { vectors: normalized, model: config.model_name, dimensions };
  }

  async function embedOne(text, options = {}) {
    const result = await requestEmbeddings([text], options);
    return { vector: result.vectors[0], model: result.model, dimensions: result.dimensions };
  }

  function normalizeEmbeddingConfigForList(source) {
    const value = source && typeof source === 'object' ? source : {};
    return {
      provider: value.provider || 'openai-compatible',
      base_url: value.base_url || '',
      api_key: value.api_key || '',
      model_name: value.model_name || '',
      dimensions: Number(value.dimensions) || 0,
      batch_size: Number(value.batch_size) || 0,
    };
  }

  async function listModels(configOverride) {
    let config;
    if (configOverride && typeof configOverride === 'object') {
      config = normalizeEmbeddingConfigForList(configOverride);
    } else {
      try {
        config = loadConfig();
      } catch (error) {
        return { success: false, message: error.message || String(error), models: [] };
      }
    }
    const trimmedBaseUrl = trimBaseUrl(config.base_url);
    if (!trimmedBaseUrl) {
      return { success: false, message: '请先填写 Embedding 服务 Base URL', models: [] };
    }
    if (!config.api_key) {
      return { success: false, message: '请先填写 Embedding 服务 API Key', models: [] };
    }

    try {
      const response = await postJsonWithTimeout(`${trimmedBaseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
        },
      }, EMBEDDING_REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const errorText = await response.text();
        const message = readErrorMessage(safeParseJson(errorText), `Embedding 服务返回 HTTP ${response.status}`);
        return { success: false, message, models: [] };
      }

      const data = await response.json();
      const models = Array.isArray(data?.data)
        ? data.data.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean)
        : [];

      return {
        success: true,
        message: models.length ? 'Embedding 模型列表已更新' : '该 Embedding 服务未返回可用模型，请手动输入',
        models,
      };
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? 'Embedding 服务请求超时'
        : `获取 Embedding 模型列表失败：${error.message || String(error)}`;
      return { success: false, message, models: [] };
    }
  }

  function safeParseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function testConnection(options = {}) {
    const probeText = 'embedding connectivity probe';
    const result = await requestEmbeddings([probeText], { ...options, logTitle: 'connection-test' });
    const vector = result.vectors[0] || [];
    return {
      success: true,
      model: result.model,
      dimensions: result.dimensions,
      preview: vector.slice(0, 4),
    };
  }

  function chunkInputs(texts, batchSize) {
    const size = Math.max(1, Math.min(128, Math.floor(Number(batchSize) || 32)));
    const chunks = [];
    for (let i = 0; i < texts.length; i += size) {
      chunks.push(texts.slice(i, i + size));
    }
    return chunks;
  }

  async function embedBatch(texts, options = {}) {
    const config = loadConfig();
    const flat = (Array.isArray(texts) ? texts : [texts])
      .map((text) => String(text || '').trim())
      .filter(Boolean);
    if (!flat.length) return [];

    const batches = chunkInputs(flat, config.batch_size);
    const collected = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batchTexts = batches[index];
      const result = await requestEmbeddings(batchTexts, {
        logTitle: `${options.logTitle || 'batch'}-${index + 1}`,
      });
      collected.push(...result.vectors);
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          batchIndex: index + 1,
          batchCount: batches.length,
          completed: collected.length,
          total: flat.length,
        });
      }
    }
    return collected;
  }

  return {
    embedOne,
    embedBatch,
    listModels,
    requestEmbeddings,
    testConnection,
    serializeVector,
    deserializeVector,
    normalizeVector,
  };
}

module.exports = { createEmbeddingService };
