const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadSelectedKnowledgeText } = require('./templateFillTask.cjs');

function createKnowledgeBaseService() {
  return {
    readReferences() {
      return [
        {
          document: { id: 'doc-1' },
          items: [
            { id: 'item-a', content: '条目甲正文' },
            { id: 'item-b', content: '条目乙正文' },
          ],
        },
      ];
    },
  };
}

describe('templateFillTask.loadSelectedKnowledgeText', () => {
  it('does not inject reference documents when the leaf has no knowledge items', () => {
    const text = loadSelectedKnowledgeText(createKnowledgeBaseService(), ['doc-1'], {
      knowledge_item_ids: [],
    });
    assert.equal(text, '');
  });

  it('only injects the checked knowledge items', () => {
    const text = loadSelectedKnowledgeText(createKnowledgeBaseService(), ['doc-1'], {
      knowledge_item_ids: ['doc-1::item-b'],
    });
    assert.equal(text, '条目乙正文');
  });
});
