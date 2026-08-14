const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTenderRequirementLedger, createTenderRequirementLedgerFingerprint, evaluateRequiredOutlineCoverage, formatTenderRequirements, getRequiredOutlineTitles, isTenderRequirementLedgerConfirmed, selectRequirementsForChapter, _internals } = require('./tenderRequirementLedger.cjs');

function success(content) { return { status: 'success', content: JSON.stringify(content) }; }

test('builds authoritative ledger with evidence and legacy facts', () => {
  const storedPlan = { bidAnalysisTasks: {
    projectInfo: success({ project_name: '测试项目', project_address: '上海' }),
    outlineRequirements: success({ required_titles: ['项目实施方案', '质量保障方案'], requirements: [{ title: '一级目录', requirement: '一级标题必须按给定顺序编排', constraint_type: 'mandatory', scope: ['目录'], source: { section: '第六章', page: '88', quote: '技术文件目录如下' } }] }),
    personnelRequirements: success({ requirements: [{ title: '安全员配置', requirement: '安全员不少于2人', constraint_type: 'minimum', scope: ['人员配置'], source: { section: '评分表', page: '42', quote: '安全员不少于2人' } }] }),
    equipmentRequirements: success({ requirements: [{ title: '检测设备', requirement: '检测仪不少于2台' }] }),
  } };
  const ledger = buildTenderRequirementLedger(storedPlan);
  assert.equal(ledger.authority, 'tender');
  assert.ok(ledger.items.some((item) => item.category === 'project' && item.value === '测试项目'));
  assert.ok(ledger.items.some((item) => item.category === 'personnel' && item.source.page === '42'));
  assert.deepEqual(getRequiredOutlineTitles(storedPlan), ['项目实施方案', '质量保障方案']);
  assert.match(formatTenderRequirements(ledger.items), /安全员不少于2人/);
  const selected = selectRequirementsForChapter(ledger, { title: '项目人员组织方案' }, []);
  assert.ok(selected.some((item) => item.category === 'personnel'));
  assert.ok(!selected.some((item) => item.category === 'equipment'));
});

test('accepts fenced JSON and ignores missing values', () => {
  const taskState = { status: 'success', content: '```json\n{"requirements":[{"title":"未提及项","requirement":"没有提及"},{"title":"工期","requirement":"60天"}]}\n```' };
  const items = _internals.requirementsFromTask('deliveryAndServiceRequirements', taskState);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, '60天');
});
test('fingerprint confirmation invalidates after authoritative result changes', () => {
  const bidAnalysisTasks = {
    outlineRequirements: success({ required_titles: ['一、项目实施方案', '二、质量保障方案'], requirements: [] }),
    personnelRequirements: success({ requirements: [{ title: '项目经理', requirement: '项目经理1名' }] }),
    equipmentRequirements: success({ requirements: [] }),
    technicalParameterRequirements: success({ requirements: [] }),
  };
  const plan = { bidAnalysisTasks };
  const fingerprint = createTenderRequirementLedgerFingerprint(plan);
  assert.equal(fingerprint.length, 64);
  assert.equal(isTenderRequirementLedgerConfirmed({ ...plan, requirementLedgerConfirmedHash: fingerprint }), true);
  bidAnalysisTasks.personnelRequirements = success({ requirements: [{ title: '项目经理', requirement: '项目经理2名' }] });
  assert.equal(isTenderRequirementLedgerConfirmed({ ...plan, requirementLedgerConfirmedHash: fingerprint }), false);
});

test('evaluates required top-level outline coverage', () => {
  const plan = { bidAnalysisTasks: {
    outlineRequirements: success({ required_titles: ['一、项目实施方案', '二、质量保障方案'], requirements: [] }),
  } };
  const coverage = evaluateRequiredOutlineCoverage(plan, { outline: [
    { title: '项目实施方案' },
    { title: '其他章节' },
  ] });
  assert.deepEqual(coverage.matched, ['一、项目实施方案']);
  assert.deepEqual(coverage.missing, ['二、质量保障方案']);
  assert.equal(coverage.covered, false);
});