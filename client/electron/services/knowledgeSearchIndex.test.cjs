const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./knowledgeSearchIndex.cjs');

describe('knowledgeSearchIndex helpers', () => {
  it('escapes LIKE and FTS query characters', () => {
    assert.equal(_internals.escapeLikeQuery('50%_off'), '50\\%\\_off');
    assert.equal(_internals.escapeFtsQuery('项目"管理'), '"项目""管理"');
  });

  it('builds a snippet around the keyword', () => {
    const snippet = _internals.buildSnippet('项目经理负责现场协调和进度管理。', '现场协调', 80);
    assert.match(snippet, /现场协调/);
  });

  it('clamps search limit', () => {
    assert.equal(_internals.normalizeSearchLimit(0), 1);
    assert.equal(_internals.normalizeSearchLimit(999), 100);
    assert.equal(_internals.normalizeSearchLimit('x'), 40);
  });
});
