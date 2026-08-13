const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTenderRequirementLedger, createTenderRequirementLedgerFingerprint, evaluateRequiredOutlineCoverage, formatTenderRequirements, getRequiredOutlineTitles, isTenderRequirementLedgerConfirmed, _internals } = require('./tenderRequirementLedger.cjs');

function success(content) { return { status: 'success', content: JSON.stringify(content) }; }

test('builds authoritative ledger from required project and delivery facts only', () => {
  const storedPlan = { bidAnalysisTasks: {
    projectInfo: success({ project_name: '测试项目', project_address: '上海' }),
    deliveryAndServiceRequirements: success({ implementation_period: '60天', delivery_location: '上海' }),
    outlineRequirements: { status: 'success', content: '# 投标文件目录要求\n\n## 项目实施方案' },
    personnelRequirements: { status: 'success', content: '# 人员要求\n\n## 安全员配置\n- 【具体要求】：安全员不少于2人' },
  } };
  const ledger = buildTenderRequirementLedger(storedPlan);
  assert.equal(ledger.authority, 'tender');
  assert.ok(ledger.items.some((item) => item.category === 'project' && item.value === '测试项目'));
  assert.ok(ledger.items.some((item) => item.category === 'delivery' && item.value === '60天'));
  assert.deepEqual(getRequiredOutlineTitles(storedPlan), []);
  assert.doesNotMatch(formatTenderRequirements(ledger.items), /安全员不少于2人/);
});

test('accepts fenced JSON and ignores missing values', () => {
  const taskState = { status: 'success', content: '```json\n{"requirements":[{"title":"未提及项","requirement":"没有提及"},{"title":"工期","requirement":"60天"}]}\n```' };
  const items = _internals.requirementsFromTask('deliveryAndServiceRequirements', taskState);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, '60天');
});
test('fingerprint confirmation invalidates after authoritative result changes', () => {
  const bidAnalysisTasks = {
    projectInfo: success({ project_name: '测试项目' }),
    deliveryAndServiceRequirements: success({ implementation_period: '60天' }),
  };
  const plan = { bidAnalysisTasks };
  const fingerprint = createTenderRequirementLedgerFingerprint(plan);
  assert.equal(fingerprint.length, 64);
  assert.equal(isTenderRequirementLedgerConfirmed({ ...plan, requirementLedgerConfirmedHash: fingerprint }), true);
  bidAnalysisTasks.deliveryAndServiceRequirements = success({ implementation_period: '90天' });
  assert.equal(isTenderRequirementLedgerConfirmed({ ...plan, requirementLedgerConfirmedHash: fingerprint }), false);
});

test('optional outline extraction does not enforce top-level outline coverage', () => {
  const plan = { bidAnalysisTasks: {
    outlineRequirements: { status: 'success', content: '# 投标文件目录要求\n\n## 项目实施方案' },
  } };
  const coverage = evaluateRequiredOutlineCoverage(plan, { outline: [
    { title: '项目实施方案' },
    { title: '其他章节' },
  ] });
  assert.deepEqual(coverage.matched, []);
  assert.deepEqual(coverage.missing, []);
  assert.equal(coverage.covered, true);
});
