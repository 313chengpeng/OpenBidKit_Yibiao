const { app } = require('electron');
const Database = require('better-sqlite3');
const {
  createKnowledgeSearchSchema,
  backfillKnowledgeSearch,
  reindexDocumentSearch,
  removeDocumentSearch,
  searchKnowledge,
} = require('./knowledgeSearchIndex.cjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function seedKnowledge(db) {
  const now = new Date().toISOString();
  db.exec(`
    CREATE TABLE knowledge_folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_documents (
      document_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      file_name TEXT NOT NULL
    );
    CREATE TABLE knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      resume TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      heading_path_json TEXT,
      content TEXT NOT NULL,
      is_filtered INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 0, ?, ?)').run('folder-a', '历史方案', now, now);
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 1, ?, ?)').run('folder-b', '其他资料', now, now);
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?)').run('doc-a', 'folder-a', '智慧园区实施方案.docx');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?)').run('doc-b', 'folder-b', '无关报价表.xlsx');
  db.prepare('INSERT INTO knowledge_items (document_id, item_id, title, resume, content, sort_order) VALUES (?, ?, ?, ?, ?, 0)')
    .run('doc-a', 'K000001', '项目管理组织', '项目经理职责', '项目经理负责现场协调和进度管理。');
  db.prepare('INSERT INTO knowledge_blocks (document_id, block_id, heading_path_json, content, is_filtered, sort_order) VALUES (?, ?, ?, ?, 0, 0)')
    .run('doc-a', 'P000001', '["实施保障"]', '应急预案应覆盖停电和网络中断。');
  db.prepare('INSERT INTO knowledge_blocks (document_id, block_id, heading_path_json, content, is_filtered, sort_order) VALUES (?, ?, ?, ?, 1, 0)')
    .run('doc-a', 'F000001', '[]', '这段被筛除的应急预案不应被检索到。');
}

function runTest() {
  const db = new Database(':memory:');
  try {
    seedKnowledge(db);
    createKnowledgeSearchSchema(db);
    backfillKnowledgeSearch(db, { force: true });

    assert(searchKnowledge(db, { query: '' }).length === 0, 'empty query should return no results');

    const itemHits = searchKnowledge(db, { query: '项目管理' });
    assert(itemHits.some((hit) => hit.type === 'item' && hit.itemId === 'K000001'), 'should find knowledge item by title');
    assert(itemHits.some((hit) => hit.documentId === 'doc-a'), 'item hit should point to source document');

    const blockHits = searchKnowledge(db, { query: '应急预案' });
    assert(blockHits.some((hit) => hit.type === 'block' && hit.blockId === 'P000001'), 'should find unfiltered block');
    assert(!blockHits.some((hit) => hit.blockId === 'F000001'), 'filtered blocks must stay out of search');

    const folderHits = searchKnowledge(db, { query: '项目管理', folderId: 'folder-b' });
    assert(folderHits.length === 0, 'folder filter should exclude other folders');

    const fileHits = searchKnowledge(db, { query: '智慧园区' });
    assert(fileHits.some((hit) => hit.type === 'document' && hit.documentId === 'doc-a'), 'should find document by file name');

    removeDocumentSearch(db, 'doc-a');
    assert(!searchKnowledge(db, { query: '项目管理' }).some((hit) => hit.documentId === 'doc-a'), 'deleted document should leave the index');
    reindexDocumentSearch(db, 'doc-a');
    assert(searchKnowledge(db, { query: '项目管理' }).some((hit) => hit.documentId === 'doc-a'), 'reindex should restore document hits');

    console.log('[knowledge-search] FTS index, folder filter, and filtered-block exclusion passed.');
  } finally {
    db.close();
  }
}

function exitWithCode(code) {
  if (app?.isReady?.()) {
    app.exit(code);
    return;
  }
  process.exit(code);
}

function main() {
  try {
    runTest();
    exitWithCode(0);
  } catch (error) {
    console.error('[knowledge-search] test failed.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  }
}

if (app?.whenReady) {
  app.whenReady().then(main, (error) => {
    console.error('[knowledge-search] Electron app failed to become ready.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  });
} else {
  main();
}
