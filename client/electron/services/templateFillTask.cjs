function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectLeaves(items, mode) {
  const leaves = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.children?.length) {
      leaves.push(...collectLeaves(item.children, mode));
      continue;
    }
    if (!mode || item?.content_mode === mode) {
      leaves.push(item);
    }
  }
  return leaves;
}

function formatGlobalFacts(globalFacts) {
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group, index) => {
      const title = singleLine(group?.title || `全局事实${index + 1}`);
      const content = String(group?.content || '').trim();
      return title && content ? `## ${title}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function loadSelectedKnowledgeText(knowledgeBaseService, documentIds, item) {
  const selectedIds = new Set((Array.isArray(item?.knowledge_item_ids) ? item.knowledge_item_ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!selectedIds.size || !knowledgeBaseService?.readReferences || !Array.isArray(documentIds) || !documentIds.length) {
    return '';
  }
  try {
    const references = knowledgeBaseService.readReferences(documentIds);
    const parts = [];
    for (const reference of Array.isArray(references) ? references : []) {
      for (const knowledgeItem of Array.isArray(reference?.items) ? reference.items : []) {
        const itemId = String(knowledgeItem?.id || '').trim();
        const content = String(knowledgeItem?.content || '').trim();
        if (!content) continue;
        if (selectedIds.has(itemId) || selectedIds.has(`${reference?.document?.id}::${itemId}`)) {
          parts.push(content);
        }
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

function updateOutlineContent(items, nodeId, content) {
  return (items || []).map((item) => {
    if (item.id === nodeId) {
      return { ...item, content };
    }
    return item.children?.length
      ? { ...item, children: updateOutlineContent(item.children, nodeId, content) }
      : item;
  });
}

function buildTemplateFillPrompt({ item, tenderMarkdown, responseFileRequirements, globalFactsText, knowledgeText }) {
  return `任务：根据招标原文填写“${singleLine(item.title)}”对应的模板或表格。

章节说明：
${String(item.description || '').trim() || '无'}

工作要求：
1. 先从招标文件和响应文件要求中抽出该小节对应的原文模板、表格字段或填写口径，再填写。
2. 只填写有依据的内容；没有依据的格子写“【待填写】”，不要编造资质、业绩、报价、联系人或证书编号。
3. 优先输出 Markdown 表格；如果原文是固定格式，尽量保持原字段顺序。
4. 不要输出分析过程，只输出可直接写入正文的 Markdown。

响应文件要求：
${String(responseFileRequirements || '').trim() || '未提供'}

全局事实：
${globalFactsText || '未提供'}

已选知识库：
${knowledgeText || '未选择'}

招标文件：
${String(tenderMarkdown || '').trim() || '未提供'}`;
}

async function runTemplateFillTask({
  aiService,
  workspaceStore,
  knowledgeBaseService,
  updateTask,
  checkpointTask,
  payload,
}) {
  const plan = workspaceStore.loadTechnicalPlan() || {};
  const outline = plan.outlineData?.outline || [];
  const requestedIds = new Set((Array.isArray(payload?.nodeIds) ? payload.nodeIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const leaves = collectLeaves(outline, 'template-fill')
    .filter((item) => !requestedIds.size || requestedIds.has(item.id));
  if (!leaves.length) {
    throw new Error('当前目录没有需要填充的模板小节');
  }

  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  const responseFileRequirements = plan.bidAnalysisTasks?.responseFileRequirements?.status === 'success'
    ? plan.bidAnalysisTasks.responseFileRequirements.content
    : '';
  const globalFactsText = formatGlobalFacts(plan.globalFacts);
  const knowledgeDocumentIds = plan.referenceKnowledgeDocumentIds || [];

  let currentOutline = outline;
  let completed = 0;
  checkpointTask({
    status: 'running',
    progress: 0,
    logs: [`开始填充 ${leaves.length} 个模板小节。`],
  });

  for (const item of leaves) {
    checkpointTask({
      status: 'running',
      progress: Math.round((completed / leaves.length) * 100),
      logs: [`正在填充 ${item.id} ${item.title}`],
    });
    const content = String(await aiService.chat({
      messages: [
        { role: 'system', content: '你是投标文件模板填写助手。只根据给定材料填写，不确定就写【待填写】。' },
        {
          role: 'user',
          content: buildTemplateFillPrompt({
            item,
            tenderMarkdown,
            responseFileRequirements,
            globalFactsText,
            knowledgeText: loadSelectedKnowledgeText(knowledgeBaseService, knowledgeDocumentIds, item),
          }),
        },
      ],
      logTitle: `模板填写-${item.title}`,
    }) || '').trim();
    if (!content) {
      throw new Error(`${item.id} ${item.title} 填充结果为空`);
    }

    workspaceStore.saveChapterContent({ nodeId: item.id, content });
    currentOutline = updateOutlineContent(currentOutline, item.id, content);
    completed += 1;
    const nextPlan = workspaceStore.loadTechnicalPlan() || {};
    checkpointTask(
      {
        status: 'running',
        progress: Math.round((completed / leaves.length) * 100),
        logs: [`已完成 ${item.id} ${item.title}`],
      },
      {
        outlineData: { ...(plan.outlineData || {}), outline: currentOutline },
        contentGenerationSections: nextPlan.contentGenerationSections,
      },
      {
        outlineData: { ...(plan.outlineData || {}), outline: currentOutline },
        contentSection: nextPlan.contentGenerationSections?.[item.id],
      },
    );
  }

  checkpointTask({ status: 'success', progress: 100, error: undefined, logs: ['模板填写完成。'] });
}

module.exports = {
  loadSelectedKnowledgeText,
  runTemplateFillTask,
};
