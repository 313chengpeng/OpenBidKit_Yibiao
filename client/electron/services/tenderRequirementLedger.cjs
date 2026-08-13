const crypto = require('node:crypto');

const AUTHORITY_LEVEL = 'tender';
const REQUIRED_AUTHORITY_TASK_IDS = Object.freeze([
  'projectInfo',
  'deliveryAndServiceRequirements',
]);

const taskCategories = Object.freeze({
  projectInfo: 'project',
  deliveryAndServiceRequirements: 'delivery',
});

const categoryKeywords = Object.freeze({
  delivery: ['工期', '进度', '交付', '实施', '验收', '质保', '售后', '培训', '文档', '服务'],
  project: ['项目', '概述', '总体', '背景'],
});

function stripCodeFence(value) {
  const text = String(value || '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(stripCodeFence(value));
  } catch {
    return null;
  }
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createRequirementId(taskId, key, value) {
  const hash = crypto.createHash('sha256').update(`${taskId}\n${key}\n${value}`, 'utf8').digest('hex').slice(0, 12);
  return `tender::${taskId}::${hash}`;
}

function isMissingValue(value) {
  const text = singleLine(value);
  return !text || /^(没有提及|未提及|未找到|无|不适用)$/u.test(text);
}

function normalizeSource(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    section: singleLine(raw.section || raw.chapter || raw.location),
    page: singleLine(raw.page || raw.page_number),
    quote: String(raw.quote || raw.evidence || '').trim(),
  };
}

function normalizeRequirement(taskId, category, raw, index) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = String(source.requirement || source.value || source.content || '').trim();
  if (isMissingValue(value)) return null;
  const title = singleLine(source.title || source.name || `${category}-${index + 1}`);
  const scope = Array.isArray(source.scope)
    ? source.scope.map(singleLine).filter(Boolean)
    : singleLine(source.scope) ? [singleLine(source.scope)] : [];
  return {
    id: createRequirementId(taskId, `${index}:${title}`, value),
    category,
    title,
    value,
    constraint_type: singleLine(source.constraint_type || source.type || 'mandatory') || 'mandatory',
    scope,
    source: normalizeSource(source.source),
    authority: AUTHORITY_LEVEL,
  };
}

function flattenObjectRequirements(taskId, category, value, path = [], results = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenObjectRequirements(taskId, category, item, [...path, String(index + 1)], results));
    return results;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => flattenObjectRequirements(taskId, category, item, [...path, key], results));
    return results;
  }
  const text = String(value ?? '').trim();
  if (isMissingValue(text)) return results;
  const title = path.join('.') || category;
  results.push({
    id: createRequirementId(taskId, title, text),
    category,
    title,
    value: text,
    constraint_type: 'mandatory',
    scope: [],
    source: { section: '', page: '', quote: '' },
    authority: AUTHORITY_LEVEL,
  });
  return results;
}

function requirementsFromTask(taskId, taskState) {
  if (taskState?.status !== 'success') return [];
  const category = taskCategories[taskId];
  if (!category) return [];
  const parsed = safeJsonParse(taskState.content);
  if (!parsed) return [];
  if (Array.isArray(parsed.requirements)) {
    return parsed.requirements.map((item, index) => normalizeRequirement(taskId, category, item, index)).filter(Boolean);
  }
  return flattenObjectRequirements(taskId, category, parsed);
}

function buildTenderRequirementLedger(storedPlan) {
  const tasks = storedPlan?.bidAnalysisTasks || {};
  const items = Object.keys(taskCategories).flatMap((taskId) => requirementsFromTask(taskId, tasks[taskId]));
  return {
    version: 1,
    authority: AUTHORITY_LEVEL,
    items,
  };
}

function matchesChapter(item, chapterText) {
  if (!chapterText) return true;
  const scopeText = (item.scope || []).join(' ');
  if (scopeText && (item.scope || []).some((scope) => chapterText.includes(scope) || scope.includes(chapterText))) return true;
  const keywords = categoryKeywords[item.category] || [];
  return keywords.some((keyword) => chapterText.includes(keyword));
}

function selectRequirementsForChapter(ledger, chapter, parentChapters = []) {
  const chapterText = [...(parentChapters || []), chapter]
    .map((item) => `${item?.title || ''} ${item?.description || ''}`)
    .join(' ');
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const scoped = items.filter((item) => matchesChapter(item, chapterText));
  const always = items.filter((item) => item.category === 'project');
  return [...new Map([...always, ...scoped].map((item) => [item.id, item])).values()];
}

function formatTenderRequirements(items, maxChars = 12_000) {
  const lines = (Array.isArray(items) ? items : []).map((item, index) => {
    const source = [item.source?.section, item.source?.page ? `第${item.source.page}页` : ''].filter(Boolean).join('，');
    return `${index + 1}. [${item.category}] ${item.title}：${item.value}${source ? `（来源：${source}）` : ''}`;
  });
  return lines.join('\n').slice(0, Math.max(0, maxChars));
}

function getRequiredOutlineTitles() {
  return [];
}

function getMissingAuthorityTaskIds(storedPlan) {
  const tasks = storedPlan?.bidAnalysisTasks || {};
  return REQUIRED_AUTHORITY_TASK_IDS.filter((taskId) => (
    tasks[taskId]?.status !== 'success' || !String(tasks[taskId]?.content || '').trim()
  ));
}

function createTenderRequirementLedgerFingerprint(storedPlan) {
  if (getMissingAuthorityTaskIds(storedPlan).length) return '';
  const ledger = buildTenderRequirementLedger(storedPlan);
  const payload = {
    version: ledger.version,
    items: ledger.items,
    required_outline_titles: getRequiredOutlineTitles(storedPlan),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function isTenderRequirementLedgerConfirmed(storedPlan) {
  const fingerprint = createTenderRequirementLedgerFingerprint(storedPlan);
  return Boolean(fingerprint && fingerprint === String(storedPlan?.requirementLedgerConfirmedHash || ''));
}

function evaluateRequiredOutlineCoverage(storedPlan, outlineData) {
  const normalizeTitle = (value) => singleLine(value).replace(/[一二三四五六七八九十\d]+[、.．]\s*/gu, '');
  const requiredTitles = getRequiredOutlineTitles(storedPlan);
  const topLevelTitles = (Array.isArray(outlineData?.outline) ? outlineData.outline : []).map((item) => singleLine(item?.title));
  const normalizedTopLevel = new Set(topLevelTitles.map(normalizeTitle).filter(Boolean));
  const matched = requiredTitles.filter((title) => normalizedTopLevel.has(normalizeTitle(title)));
  const missing = requiredTitles.filter((title) => !normalizedTopLevel.has(normalizeTitle(title)));
  return {
    required: requiredTitles,
    matched,
    missing,
    covered: missing.length === 0,
  };
}

module.exports = {
  REQUIRED_AUTHORITY_TASK_IDS,
  buildTenderRequirementLedger,
  createTenderRequirementLedgerFingerprint,
  evaluateRequiredOutlineCoverage,
  formatTenderRequirements,
  getMissingAuthorityTaskIds,
  getRequiredOutlineTitles,
  isTenderRequirementLedgerConfirmed,
  selectRequirementsForChapter,
  _internals: { safeJsonParse, requirementsFromTask },
};
