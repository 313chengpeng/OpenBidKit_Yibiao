const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { inferContentMode, parseOutlineFromMarkdown, stripHeadingNumber } = require('./outlineImportService.cjs');

describe('outlineImportService', () => {
  it('strips heading numbers and infers leaf modes', () => {
    assert.equal(stripHeadingNumber('1.1 实施方案'), '实施方案');
    assert.equal(stripHeadingNumber('一、项目概况'), '项目概况');
    assert.equal(inferContentMode('技术偏差点对点应答表'), 'point-to-point');
    assert.equal(inferContentMode('商务偏离表'), 'point-to-point');
    assert.equal(inferContentMode('响应文件格式'), 'template-fill');
    assert.equal(inferContentMode('分项报价表'), 'template-fill');
    assert.equal(inferContentMode('实施方案'), 'ai-generate');
  });

  it('builds a tree from ATX and Setext headings', () => {
    const markdown = [
      '# 1 项目概述',
      '',
      '概述正文',
      '',
      '技术方案',
      '=======',
      '',
      '## 2.1 总体方案',
      '### 2.1.1 架构设计',
      '## 2.2 点对点应答表',
      '## 2.3 投标格式一览表',
      '',
      '# 附录标题',
    ].join('\n');

    const result = parseOutlineFromMarkdown(markdown);
    assert.equal(result.success, true);
    assert.equal(result.outline.length, 3);
    assert.equal(result.outline[0].id, '1');
    assert.equal(result.outline[0].title, '项目概述');
    assert.equal(result.outline[0].content_mode, 'ai-generate');
    assert.equal(result.outline[1].id, '2');
    assert.equal(result.outline[1].title, '技术方案');
    assert.equal(result.outline[1].children[0].id, '2.1');
    assert.equal(result.outline[1].children[0].children[0].id, '2.1.1');
    assert.equal(result.outline[1].children[1].content_mode, 'point-to-point');
    assert.equal(result.outline[1].children[2].content_mode, 'template-fill');
    assert.equal(result.outline[2].title, '附录标题');
  });

  it('reports missing headings and truncated deep levels', () => {
    assert.equal(parseOutlineFromMarkdown('只有正文没有标题').success, false);
    const deep = parseOutlineFromMarkdown('####### 超深标题\n# 正常标题');
    assert.equal(deep.success, true);
    assert.equal(deep.truncated, true);
    assert.match(deep.warnings[0], /6 级/);
  });
});
