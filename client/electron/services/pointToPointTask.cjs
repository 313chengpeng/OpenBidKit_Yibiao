function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectLeaves(items) {
  const leaves = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.children?.length) {
      leaves.push(...collectLeaves(item.children));
    } else {
      leaves.push(item);
    }
  }
  return leaves;
}

function summarizeContent(content, limit = 240) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '待正文';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function buildOutlineCatalog(items) {
  return collectLeaves(items).map((item) => {
    const hasContent = Boolean(String(item?.content || '').trim());
    return `- ${item.id} ${item.title}｜模式：${item.content_mode || 'ai-generate'}｜正文：${hasContent ? summarizeContent(item.content) : '待正文'}`;
  }).join('\n');
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

function buildPointToPointPrompt({ item, techRequirements, businessScoring, outlineCatalog }) {
  return `任务：为目录小节“${singleLine(item.title)}”生成点对点应答表。

章节说明：
${String(item.description || '').trim() || '无'}

固定输出 Markdown 表格，表头必须且只能是：
| 条款 | 招标要求 | 响应章节 | 响应结论 | 页码 |

填写规则：
1. “条款”写评分项或技术要求名称。
2. “招标要求”尽量保留招标原文要点，不要编造。
3. “响应章节”写目录编号加标题，例如“3.2 实施方案”。
4. “页码”必须写成占位 {{page:outline-节点id}}，节点id 使用当前目录树中的真实 id，例如 {{page:outline-3.2}}。
5. 如果对应章节还没有正文，响应结论写“待正文”，页码仍保留占位。
6. 只输出一张表，不要解释过程。

技术评分要求：
${String(techRequirements || '').trim() || '未提供'}

商务评分要求：
${String(businessScoring || '').trim() || '未提供'}

当前目录与正文摘要：
${outlineCatalog || '暂无目录'}`;
}

async function runPointToPointTask({
  aiService,
  workspaceStore,
  updateTask,
  checkpointTask,
  payload,
}) {
  const plan = workspaceStore.loadTechnicalPlan() || {};
  const outline = plan.outlineData?.outline || [];
  const requestedIds = new Set((Array.isArray(payload?.nodeIds) ? payload.nodeIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const leaves = collectLeaves(outline)
    .filter((item) => item.content_mode === 'point-to-point')
    .filter((item) => !requestedIds.size || requestedIds.has(item.id));
  if (!leaves.length) {
    throw new Error('当前目录没有需要生成的点对点应答表小节');
  }

  const techRequirements = plan.techRequirements
    || (plan.bidAnalysisTasks?.techRequirements?.status === 'success' ? plan.bidAnalysisTasks.techRequirements.content : '');
  const businessScoring = plan.bidAnalysisTasks?.businessScoring?.status === 'success'
    ? plan.bidAnalysisTasks.businessScoring.content
    : '';
  const outlineCatalog = buildOutlineCatalog(outline);

  let currentOutline = outline;
  let completed = 0;
  checkpointTask({
    status: 'running',
    progress: 0,
    logs: [`开始生成 ${leaves.length} 个点对点应答表。`],
  });

  for (const item of leaves) {
    checkpointTask({
      status: 'running',
      progress: Math.round((completed / leaves.length) * 100),
      logs: [`正在生成 ${item.id} ${item.title}`],
    });
    const content = String(await aiService.chat({
      messages: [
        { role: 'system', content: '你是投标点对点应答表助手。只输出指定列的 Markdown 表格，页码必须使用 {{page:outline-节点id}} 占位。' },
        {
          role: 'user',
          content: buildPointToPointPrompt({
            item,
            techRequirements,
            businessScoring,
            outlineCatalog,
          }),
        },
      ],
      logTitle: `点对点应答表-${item.title}`,
    }) || '').trim();
    if (!content) {
      throw new Error(`${item.id} ${item.title} 应答表结果为空`);
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

  updateTask({ logs: ['点对点应答表生成完成。'] });
  checkpointTask({ status: 'success', progress: 100, error: undefined, logs: ['点对点应答表生成完成。'] });
}

module.exports = {
  runPointToPointTask,
};
