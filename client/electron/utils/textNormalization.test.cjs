const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyTextNormalizationToMarkdown, convertChineseQuotes } = require('./textNormalization.cjs');

const quotesOn = { chinese_quotes: true };

describe('applyTextNormalizationToMarkdown', () => {
  it('converts quotes in ordinary Markdown text', () => {
    assert.equal(applyTextNormalizationToMarkdown('他说"你好"', quotesOn), '他说“你好”');
  });

  it('keeps link destination and title quotes intact', () => {
    const source = '详见[链接](https://example.com "标题")。';
    assert.equal(applyTextNormalizationToMarkdown(source, quotesOn), '详见[链接](https://example.com "标题")。');
  });

  it('keeps HTML attribute quotes intact and still converts nearby text', () => {
    const source = '见图<img src="diagram.png" alt="示意图">中的"要点"。';
    assert.equal(
      applyTextNormalizationToMarkdown(source, quotesOn),
      '见图<img src="diagram.png" alt="示意图">中的“要点”。',
    );
  });

  it('keeps fenced code and inline code quotes intact', () => {
    const source = '正文"引用"和`const name = "易标"`。\n\n```js\nconsole.log("ok")\n```';
    const result = applyTextNormalizationToMarkdown(source, quotesOn);
    assert.equal(result.includes('正文“引用”'), true);
    assert.equal(result.includes('`const name = "易标"`'), true);
    assert.equal(result.includes('console.log("ok")'), true);
  });
});

describe('convertChineseQuotes', () => {
  it('does not rewrite apostrophes inside English words', () => {
    assert.equal(convertChineseQuotes("don't"), "don't");
  });
});
