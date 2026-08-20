const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./rejectionCheckTask.cjs');

function createAiService(contextLengthLimit) {
  return {
    getConfig() {
      return { context_length_limit: contextLengthLimit };
    },
  };
}

function createDocument(id, content) {
  return { id, fileName: `${id}.md`, content };
}

describe('createIdentityCheckUnits', () => {
  it('keeps a small package as one unsegmented unit', () => {
    const documents = [
      createDocument('doc-a', '甲方名称'),
      createDocument('doc-b', '乙方名称'),
    ];
    const units = _internals.createIdentityCheckUnits(createAiService(400000), documents);
    assert.equal(units.length, 1);
    assert.deepEqual(units[0].bidDocuments, documents);
    assert.equal(units[0].normalizeDocuments, undefined);
  });

  it('splits a single oversized document into content segments', () => {
    const document = createDocument('doc-huge', `${'暗标检查。'.repeat(80)}\n`.repeat(6));
    const units = _internals.createIdentityCheckUnits(createAiService(200), [document]);
    assert.ok(units.length > 1);
    assert.ok(units.every((unit) => unit.bidDocuments.length === 1));
    assert.ok(units.every((unit) => unit.bidDocuments[0].content.length < document.content.length));
    assert.ok(units.every((unit) => unit.normalizeDocuments[0] === document));
    assert.ok(units.every((unit) => Number.isFinite(unit.segmentStartOffset)));
    const reconstructed = units.map((unit) => unit.bidDocuments[0].content).join('');
    assert.equal(reconstructed, document.content);
  });

  it('splits each oversized document instead of sending the file whole', () => {
    const first = createDocument('doc-1', `${'单位名称。'.repeat(80)}\n`.repeat(4));
    const second = createDocument('doc-2', `${'联系电话。'.repeat(80)}\n`.repeat(4));
    const units = _internals.createIdentityCheckUnits(createAiService(200), [first, second]);
    assert.ok(units.length > 2);
    assert.ok(units.some((unit) => unit.normalizeDocuments[0].id === 'doc-1'));
    assert.ok(units.some((unit) => unit.normalizeDocuments[0].id === 'doc-2'));
    assert.ok(units.every((unit) => unit.bidDocuments[0].content.length < Math.max(first.content.length, second.content.length)));
  });
});
