const fs = require('node:fs');
const path = require('node:path');

const OPENXML_TOOL_NAME = 'openxml';
const LIST_BLOCKS_ACTION = 'list-blocks';
const EXTRACT_CHAPTERS_ACTION = 'extract-chapters';
const AGENT_BLOCKS_FILE = '招标原文结构.json';
const AGENT_TEMPLATE_FILE = 'bid-template.docx';
const DEFAULT_TIMEOUT_MS = 300000;

function createToolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeRelativePath(filePath) {
  const relativePath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('路径必须是当前工作区内的相对路径');
  }
  return path.posix.normalize(relativePath);
}

/** 创建 Agent 可调用的 Open XML 工具，内部转调主程序助手服务。 */
function createPiOpenXmlTool({
  workspaceDir,
  Type,
  openXmlHelperService,
  listBusinessSources,
  resolveAgentSources,
  bidTemplatePath,
  bidTemplateRelativePath,
}) {
  return {
    name: OPENXML_TOOL_NAME,
    label: 'Open XML 助手',
    description: '一次性列出全部招标 Word 原文块，或按原文标题/块区间从全部原件抽出章节生成投标模版。先调用一次 list-blocks 阅读招标原文结构.json，再调用一次 extract-chapters。不要用一级目录的改写标题去碰原文。',
    promptSnippet: '用 openxml 列出招标 Word 结构并按原文定位抽出投标模版。',
    parameters: Type.Object({
      action: Type.String({
        enum: [LIST_BLOCKS_ACTION, EXTRACT_CHAPTERS_ACTION],
        description: 'list-blocks 列出原文块；extract-chapters 按原文定位抽章。',
      }),
      chapters: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1, description: '投标模版里使用的一级目录标题。' }),
        sourceTitle: Type.Optional(Type.String({ description: '招标 Word 里的真实标题。' })),
        source: Type.Optional(Type.String({ description: '该章所在原件在招标原文结构.json 中的完整 source.path；多份 Word 原件时必填。' })),
        startBlock: Type.Optional(Type.Number({ minimum: 0, description: '起始块号，含。' })),
        endBlock: Type.Optional(Type.Number({ minimum: 1, description: '结束块号，不含。' })),
      }, { additionalProperties: false }), {
        description: 'extract-chapters 必填。每章必须提供 sourceTitle 或 startBlock。',
      })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      try {
        if (!openXmlHelperService?.runJob) {
          throw new Error('Open XML 助手尚未初始化');
        }

        const action = String(params.action || '').trim();
        const businessSources = listBusinessSources();
        if (!businessSources.length) {
          throw new Error('请重新导入招标文件');
        }

        if (action === LIST_BLOCKS_ACTION) {
          const result = await openXmlHelperService.runJob({
            action: LIST_BLOCKS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: { sources: businessSources },
            signal,
          });
          const blocksPath = path.join(result.jobDir, 'blocks.json');
          if (!fs.existsSync(blocksPath)) {
            throw new Error('助手没有写出原文结构');
          }
          const agentPath = path.join(workspaceDir, AGENT_BLOCKS_FILE);
          fs.copyFileSync(blocksPath, agentPath);
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_BLOCKS_FILE,
            block_count: result.blockCount || result.block_count || 0,
            message: `已写入 ${AGENT_BLOCKS_FILE}，请用 read 阅读后按原文标题或块号抽章。`,
          });
        }

        if (action === EXTRACT_CHAPTERS_ACTION) {
          const chapters = resolveChapterSources(
            normalizeChapters(params.chapters),
            businessSources,
            resolveAgentSources,
          );
          if (!chapters.length) {
            throw new Error('extract-chapters 需要 chapters');
          }
          const missingLocate = chapters.filter((item) => !item.sourceTitle && item.startBlock == null);
          if (missingLocate.length) {
            throw new Error(`这些章节缺少原文定位：${missingLocate.map((item) => item.title).join('、')}`);
          }

          const result = await openXmlHelperService.runJob({
            action: EXTRACT_CHAPTERS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: {
              sources: businessSources,
              chapters,
              output: bidTemplateRelativePath,
            },
            signal,
          });

          if (bidTemplatePath && fs.existsSync(bidTemplatePath)) {
            fs.copyFileSync(bidTemplatePath, path.join(workspaceDir, AGENT_TEMPLATE_FILE));
          }

          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_TEMPLATE_FILE,
            output: result.output || bidTemplateRelativePath,
            message: '投标模版已生成。',
          });
        }

        throw new Error(`未知动作：${action}`);
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        return createToolResult({
          ok: false,
          action: params?.action || '',
          error: error?.message || String(error),
        }, true);
      }
    },
  };
}

function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((item) => ({
      id: String(item?.id || '').trim(),
      title: String(item?.title || '').trim(),
      sourceTitle: String(item?.sourceTitle || '').trim(),
      source: String(item?.source || '').trim(),
      startBlock: Number.isFinite(Number(item?.startBlock)) ? Math.floor(Number(item.startBlock)) : undefined,
      endBlock: Number.isFinite(Number(item?.endBlock)) ? Math.floor(Number(item.endBlock)) : undefined,
    }))
    .filter((item) => item.title);
}

/** 由程序绑定章节来源；多份 Word 时禁止省略 source。 */
function resolveChapterSources(chapters, businessSources, resolveAgentSources) {
  const multiple = businessSources.length > 1;
  return chapters.map((chapter) => {
    if (!chapter.source) {
      if (multiple) {
        throw new Error(`多份 Word 原件时章节必须填写 source：${chapter.title}`);
      }
      return { ...chapter, source: businessSources[0] };
    }
    const sourceHint = normalizeRelativePath(chapter.source);
    const resolved = resolveAgentSources(sourceHint);
    if (resolved.length !== 1) {
      throw new Error(`无法唯一确定章节原件：${chapter.title}`);
    }
    return { ...chapter, source: resolved[0] };
  });
}

module.exports = {
  OPENXML_TOOL_NAME,
  createPiOpenXmlTool,
};
