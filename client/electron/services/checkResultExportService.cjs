const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const identityCategoryLabels = {
  person: '人名或简称',
  org: '单位名称',
  project: '项目或编号',
  contact: '联系方式',
  region: '地区名称',
  english: '英文或单位',
  punctuation: '英文标点或符号',
  custom: '补充词',
};

function formatExportTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '检查结果';
}

function createSheet(headers, rows) {
  return XLSX.utils.aoa_to_sheet([headers, ...rows]);
}

function appendSheet(workbook, name, headers, rows) {
  XLSX.utils.book_append_sheet(workbook, createSheet(headers, rows), name);
}

async function saveWorkbook(workbook, title, defaultFilename) {
  const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
  const result = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(defaultDir, defaultFilename),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true, message: '已取消导出' };
  }

  const outputPath = result.filePath.endsWith('.xlsx') ? result.filePath : `${result.filePath}.xlsx`;
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(outputPath, buffer);
  return { success: true, path: outputPath, message: 'Excel 已导出。' };
}

function fileNameById(documents = [], documentId) {
  return documents.find((document) => document.id === documentId)?.fileName || documentId || '';
}

function hasRejectionExportableResults(state) {
  const results = [
    state?.rejectionCheckResult,
    state?.typoCheckResult,
    state?.logicCheckResult,
    state?.identityCheckResult,
  ];
  return results.some((result) => {
    if (!result) return false;
    return result.status === 'success' || result.status === 'error' || (Array.isArray(result.findings) && result.findings.length > 0);
  });
}

function hasDuplicateExportableResults(state) {
  return Boolean(
    state?.metadataAnalysis?.rows?.length
    || state?.outlineAnalysis?.duplicateGroups?.length
    || state?.contentAnalysis?.duplicateSentences?.length
    || state?.imageAnalysis?.duplicateImages?.length
    || state?.metadataAnalysis?.status === 'success'
    || state?.outlineAnalysis?.status === 'success'
    || state?.contentAnalysis?.status === 'success'
    || state?.imageAnalysis?.status === 'success',
  );
}

function buildRejectionWorkbook(state) {
  const bidDocuments = Array.isArray(state.bidDocuments) ? state.bidDocuments : [];
  const workbook = XLSX.utils.book_new();
  const typeLabels = { invalidBid: '无效标', rejectionItem: '废标项' };
  const severityLabels = { high: '高风险', medium: '中风险', low: '低风险' };

  appendSheet(workbook, '废标项', [
    '投标文件', '类型', '风险等级', '标题', '摘要', '招标要求', '投标证据', '风险原因', '建议',
  ], (state.rejectionCheckResult?.findings || []).map((item) => [
    fileNameById(bidDocuments, item.bidDocumentId),
    typeLabels[item.type] || item.type || '',
    severityLabels[item.severity] || item.severity || '',
    item.title || '',
    item.summary || '',
    item.requirement || '',
    item.bidEvidence || '',
    item.riskReason || '',
    item.suggestion || '',
  ]));

  appendSheet(workbook, '错别字', [
    '投标文件', '错误文本', '建议改正', '原文摘录', '原因', '位置',
  ], (state.typoCheckResult?.findings || []).map((item) => [
    fileNameById(bidDocuments, item.bidDocumentId),
    item.wrongText || '',
    item.correctText || '',
    item.originalExcerpt || '',
    item.reason || '',
    item.locationHint || '',
  ]));

  appendSheet(workbook, '逻辑', [
    '投标文件', '标题', '原文', '位置', '问题原因', '建议',
  ], (state.logicCheckResult?.findings || []).map((item) => [
    fileNameById(bidDocuments, item.bidDocumentId),
    item.title || '',
    item.originalText || '',
    item.locationHint || '',
    item.fallacyReason || '',
    item.suggestion || '',
  ]));

  appendSheet(workbook, '暗标', [
    '投标文件', '类别', '命中文本', '原文摘录', '位置', '风险原因', '建议',
  ], (state.identityCheckResult?.findings || []).map((item) => [
    fileNameById(bidDocuments, item.bidDocumentId),
    identityCategoryLabels[item.category] || item.category || '',
    item.matchedText || '',
    item.originalExcerpt || '',
    item.locationHint || '',
    item.riskReason || '',
    item.suggestion || '',
  ]));

  return workbook;
}

function fileNameFromDuplicate(state, fileId) {
  const files = [
    ...(Array.isArray(state.tenderFiles) ? state.tenderFiles : []),
    ...(Array.isArray(state.bidFiles) ? state.bidFiles : []),
    state.tenderFile,
  ].filter(Boolean);
  return files.find((file) => file.id === fileId)?.file_name || fileId || '';
}

function joinFileNames(state, fileIds = []) {
  return (Array.isArray(fileIds) ? fileIds : []).map((fileId) => fileNameFromDuplicate(state, fileId)).filter(Boolean).join('；');
}

function buildDuplicateWorkbook(state) {
  const workbook = XLSX.utils.book_new();
  const bidFiles = Array.isArray(state.bidFiles) ? state.bidFiles : [];

  appendSheet(workbook, '元数据', [
    '字段', '重复文件', '同日文件', ...bidFiles.map((file) => file.file_name || file.id),
  ], (state.metadataAnalysis?.rows || []).map((row) => [
    row.label || row.key || '',
    joinFileNames(state, row.duplicate_file_ids),
    joinFileNames(state, row.same_day_file_ids),
    ...bidFiles.map((file) => (row.values && row.values[file.id]) || ''),
  ]));

  appendSheet(workbook, '目录', [
    '类型', '标题', '相似度', '涉及文件', '路径',
  ], (state.outlineAnalysis?.duplicateGroups || []).map((group) => [
    group.type === 'similar' ? '相似' : '重复',
    group.title || '',
    Number.isFinite(Number(group.score)) ? Number(group.score) : '',
    joinFileNames(state, group.file_ids),
    Object.values(group.paths || {}).flat().join(' / '),
  ]));

  appendSheet(workbook, '重复句子', [
    '句子', '涉及文件', '出现次数',
  ], (state.contentAnalysis?.duplicateSentences || []).map((item) => [
    item.sentence || '',
    joinFileNames(state, item.file_ids),
    Object.values(item.occurrences || {}).reduce((sum, count) => sum + Number(count || 0), 0),
  ]));

  appendSheet(workbook, '重复图片', [
    '图片哈希', '涉及文件', '出现位置',
  ], (state.imageAnalysis?.duplicateImages || []).map((item) => [
    item.hash || '',
    joinFileNames(state, item.file_ids),
    Object.entries(item.locations || {}).flatMap(([fileId, locations]) => (
      (locations || []).map((location) => `${fileNameFromDuplicate(state, fileId)}：${location.previous_sentence || location.directory || ''}`)
    )).join('；'),
  ]));

  return workbook;
}

function createCheckResultExportService({ rejectionCheckStore, duplicateCheckStore } = {}) {
  return {
    async exportRejectionExcel() {
      const state = rejectionCheckStore.loadRejectionCheck();
      if (!hasRejectionExportableResults(state)) {
        throw new Error('当前没有可导出的检查结果');
      }
      return saveWorkbook(
        buildRejectionWorkbook(state),
        '导出废标项检查结果',
        `${sanitizeFilename('废标项检查结果')}_${formatExportTimestamp()}.xlsx`,
      );
    },
    async exportDuplicateExcel() {
      const state = duplicateCheckStore.loadDuplicateCheck();
      if (!hasDuplicateExportableResults(state)) {
        throw new Error('当前没有可导出的查重结果');
      }
      return saveWorkbook(
        buildDuplicateWorkbook(state),
        '导出标书查重结果',
        `${sanitizeFilename('标书查重结果')}_${formatExportTimestamp()}.xlsx`,
      );
    },
  };
}

module.exports = {
  createCheckResultExportService,
};
