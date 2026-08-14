const test = require('node:test');
const assert = require('node:assert/strict');
const { createDifyKnowledgeService, _internals } = require('./difyKnowledgeService.cjs');

test('splits long queries below Dify limit', () => {
  const queries = _internals.buildRetrievalQueries(`章节：${'施工组织与质量控制。'.repeat(50)}\n要求：${'人员设备和验收标准。'.repeat(40)}`, 6);
  assert.ok(queries.length >= 1 && queries.length <= 6);
  assert.ok(new Set(queries).size === queries.length);
  assert.ok(queries.every((query) => query.length <= 190));
});

test('keeps partial successes and fuses duplicate hits', async () => {
  const oldFetch = global.fetch;
  const oldBase = process.env.DIFY_API_BASE_URL;
  const oldKey = process.env.DIFY_KNOWLEDGE_API_KEY;
  process.env.DIFY_API_BASE_URL = 'https://dify.test/v1';
  process.env.DIFY_KNOWLEDGE_API_KEY = 'test-key';
  let failures = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/datasets/bad/')) return { ok: false, status: 403, text: async () => JSON.stringify({ message: 'disabled' }) };
    const body = JSON.parse(options.body);
    const suffix = body.query.includes('质量') ? 'quality' : 'method';
    return { ok: true, status: 200, text: async () => JSON.stringify({ records: [
      { score: 0.8, segment: { id: `shared-${suffix}`, document_id: 'doc-1', content: '共享知识片段', document: { name: '参考文档' } } },
      { score: 0.7, segment: { id: `unique-${suffix}`, document_id: 'doc-2', content: `独立知识片段-${suffix}`, document: { name: '参考文档' } } },
    ] }) };
  };
  try {
    const service = createDifyKnowledgeService({ app: null });
    const items = await service.retrieve(['good', 'bad'], '章节主题：施工组织\n章节说明：质量控制', { maxQueries: 2, onQueryError: () => { failures += 1; } });
    assert.equal(failures, 2);
    assert.equal(items.length, 3);
    assert.equal(items[0].content, '共享知识片段');
    assert.ok(items[0].fusion_score > items[1].fusion_score);
  } finally {
    global.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.DIFY_API_BASE_URL; else process.env.DIFY_API_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.DIFY_KNOWLEDGE_API_KEY; else process.env.DIFY_KNOWLEDGE_API_KEY = oldKey;
  }
});
