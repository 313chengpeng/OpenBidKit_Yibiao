const DEFAULT_SEARCH_LIMIT = 40;
const MAX_SEARCH_LIMIT = 100;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function createFtsTable(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_search_fts USING fts5(
        file_name,
        title,
        resume,
        body,
        content='knowledge_search_rows',
        content_rowid='id',
        tokenize='trigram'
      )
    `);
    return 'trigram';
  } catch {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_search_fts USING fts5(
        file_name,
        title,
        resume,
        body,
        content='knowledge_search_rows',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    return 'unicode61';
  }
}

function createKnowledgeSearchSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_search_rows (
      id INTEGER PRIMARY KEY,
      entity_key TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      folder_id TEXT NOT NULL DEFAULT '',
      item_id TEXT NOT NULL DEFAULT '',
      block_id TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      resume TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_search_rows_document
    ON knowledge_search_rows(document_id);

    CREATE INDEX IF NOT EXISTS idx_knowledge_search_rows_folder
    ON knowledge_search_rows(folder_id, entity_type);
  `);

  const createdFts = !tableExists(db, 'knowledge_search_fts');
  if (createdFts) {
    createFtsTable(db);
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_search_rows_ai AFTER INSERT ON knowledge_search_rows BEGIN
      INSERT INTO knowledge_search_fts(rowid, file_name, title, resume, body)
      VALUES (new.id, new.file_name, new.title, new.resume, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_search_rows_ad AFTER DELETE ON knowledge_search_rows BEGIN
      INSERT INTO knowledge_search_fts(knowledge_search_fts, rowid, file_name, title, resume, body)
      VALUES('delete', old.id, old.file_name, old.title, old.resume, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_search_rows_au AFTER UPDATE ON knowledge_search_rows BEGIN
      INSERT INTO knowledge_search_fts(knowledge_search_fts, rowid, file_name, title, resume, body)
      VALUES('delete', old.id, old.file_name, old.title, old.resume, old.body);
      INSERT INTO knowledge_search_fts(rowid, file_name, title, resume, body)
      VALUES (new.id, new.file_name, new.title, new.resume, new.body);
    END;
  `);
  if (createdFts) {
    const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_search_rows').get()?.n || 0);
    if (indexed > 0) {
      db.exec("INSERT INTO knowledge_search_fts(knowledge_search_fts) VALUES('rebuild')");
    } else {
      backfillKnowledgeSearch(db);
    }
  } else {
    backfillKnowledgeSearch(db);
  }
}

function parseHeadingPath(value) {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean).join(' / ') : '';
  } catch {
    return '';
  }
}

function insertSearchRow(db, row) {
  db.prepare(`
    INSERT INTO knowledge_search_rows (
      entity_key, entity_type, document_id, folder_id, item_id, block_id, file_name, title, resume, body
    ) VALUES (
      @entity_key, @entity_type, @document_id, @folder_id, @item_id, @block_id, @file_name, @title, @resume, @body
    )
  `).run({
    entity_key: row.entity_key,
    entity_type: row.entity_type,
    document_id: row.document_id,
    folder_id: row.folder_id || '',
    item_id: row.item_id || '',
    block_id: row.block_id || '',
    file_name: row.file_name || '',
    title: row.title || '',
    resume: row.resume || '',
    body: row.body || '',
  });
}

function removeDocumentSearch(db, documentId) {
  if (!tableExists(db, 'knowledge_search_rows')) return;
  db.prepare('DELETE FROM knowledge_search_rows WHERE document_id = ?').run(documentId);
}

function reindexDocumentSearch(db, documentId) {
  if (!tableExists(db, 'knowledge_search_rows') || !tableExists(db, 'knowledge_documents')) return;
  const document = db.prepare(`
    SELECT document_id, folder_id, file_name
    FROM knowledge_documents
    WHERE document_id = ?
  `).get(documentId);
  removeDocumentSearch(db, documentId);
  if (!document) return;

  insertSearchRow(db, {
    entity_key: `document:${document.document_id}`,
    entity_type: 'document',
    document_id: document.document_id,
    folder_id: document.folder_id,
    file_name: document.file_name,
    title: document.file_name,
  });

  const items = db.prepare(`
    SELECT item_id, title, resume, content
    FROM knowledge_items
    WHERE document_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(documentId);
  for (const item of items) {
    insertSearchRow(db, {
      entity_key: `item:${document.document_id}:${item.item_id}`,
      entity_type: 'item',
      document_id: document.document_id,
      folder_id: document.folder_id,
      item_id: item.item_id,
      file_name: document.file_name,
      title: item.title || '',
      resume: item.resume || '',
      body: item.content || '',
    });
  }

  const blocks = db.prepare(`
    SELECT block_id, heading_path_json, content
    FROM knowledge_blocks
    WHERE document_id = ? AND is_filtered = 0
    ORDER BY sort_order ASC, id ASC
  `).all(documentId);
  for (const block of blocks) {
    insertSearchRow(db, {
      entity_key: `block:${document.document_id}:${block.block_id}`,
      entity_type: 'block',
      document_id: document.document_id,
      folder_id: document.folder_id,
      block_id: block.block_id,
      file_name: document.file_name,
      title: parseHeadingPath(block.heading_path_json) || block.block_id,
      body: block.content || '',
    });
  }
}

function syncDocumentSearchMeta(db, documentId) {
  if (!tableExists(db, 'knowledge_search_rows') || !tableExists(db, 'knowledge_documents')) return;
  const document = db.prepare(`
    SELECT document_id, folder_id, file_name
    FROM knowledge_documents
    WHERE document_id = ?
  `).get(documentId);
  if (!document) {
    removeDocumentSearch(db, documentId);
    return;
  }

  const existing = db.prepare(`
    SELECT id FROM knowledge_search_rows
    WHERE entity_type = 'document' AND document_id = ?
  `).get(documentId);
  if (!existing) {
    reindexDocumentSearch(db, documentId);
    return;
  }

  db.prepare(`
    UPDATE knowledge_search_rows
    SET folder_id = ?, file_name = ?, title = CASE WHEN entity_type = 'document' THEN ? ELSE title END
    WHERE document_id = ?
  `).run(document.folder_id, document.file_name, document.file_name, documentId);
}

function backfillKnowledgeSearch(db, options = {}) {
  if (!tableExists(db, 'knowledge_documents') || !tableExists(db, 'knowledge_search_rows')) return;
  const force = Boolean(options.force);
  if (!force) {
    const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_search_rows').get()?.n || 0);
    if (indexed > 0) return;
  }
  db.prepare('DELETE FROM knowledge_search_rows').run();
  const documentIds = db.prepare('SELECT document_id FROM knowledge_documents').all().map((row) => row.document_id);
  for (const documentId of documentIds) {
    reindexDocumentSearch(db, documentId);
  }
}

function normalizeSearchLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(number)));
}

function escapeLikeQuery(value) {
  return String(value || '').replace(/([\\%_])/g, '\\$1');
}

function escapeFtsQuery(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function buildSnippet(text, query, max = 80) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const keyword = String(query || '').trim();
  if (!keyword) return source.length > max ? `${source.slice(0, max)}…` : source;
  const index = source.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return source.length > max ? `${source.slice(0, max)}…` : source;
  const start = Math.max(0, index - 16);
  const end = Math.min(source.length, index + keyword.length + 48);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

function mapSearchRow(row, query) {
  return {
    type: row.entity_type,
    documentId: row.document_id,
    folderId: row.folder_id,
    folderName: row.folder_name || '',
    fileName: row.file_name || '',
    itemId: row.item_id || undefined,
    blockId: row.block_id || undefined,
    title: row.title || row.file_name || '',
    snippet: String(row.snippet || '').trim() || buildSnippet(row.body || row.resume || row.title || row.file_name, query),
  };
}

function likeSearch(db, query, folderId, limit) {
  const pattern = `%${escapeLikeQuery(query)}%`;
  const rows = db.prepare(`
    SELECT
      r.entity_type,
      r.document_id,
      r.folder_id,
      r.item_id,
      r.block_id,
      r.file_name,
      r.title,
      r.resume,
      r.body,
      COALESCE(f.name, '') AS folder_name
    FROM knowledge_search_rows r
    LEFT JOIN knowledge_folders f ON f.folder_id = r.folder_id
    WHERE (
      r.file_name LIKE ? ESCAPE '\\'
      OR r.title LIKE ? ESCAPE '\\'
      OR r.resume LIKE ? ESCAPE '\\'
      OR r.body LIKE ? ESCAPE '\\'
    )
      AND (? = '' OR r.folder_id = ?)
    ORDER BY CASE r.entity_type WHEN 'document' THEN 0 WHEN 'item' THEN 1 ELSE 2 END, r.id ASC
    LIMIT ?
  `).all(pattern, pattern, pattern, pattern, folderId, folderId, limit);
  return rows.map((row) => mapSearchRow(row, query));
}

function ftsSearch(db, query, folderId, limit) {
  const rows = db.prepare(`
    SELECT
      r.entity_type,
      r.document_id,
      r.folder_id,
      r.item_id,
      r.block_id,
      r.file_name,
      r.title,
      r.resume,
      r.body,
      COALESCE(f.name, '') AS folder_name,
      snippet(knowledge_search_fts, 3, '', '', '…', 12) AS snippet
    FROM knowledge_search_fts
    JOIN knowledge_search_rows r ON r.id = knowledge_search_fts.rowid
    LEFT JOIN knowledge_folders f ON f.folder_id = r.folder_id
    WHERE knowledge_search_fts MATCH ?
      AND (? = '' OR r.folder_id = ?)
    ORDER BY bm25(knowledge_search_fts), CASE r.entity_type WHEN 'document' THEN 0 WHEN 'item' THEN 1 ELSE 2 END
    LIMIT ?
  `).all(escapeFtsQuery(query), folderId, folderId, limit);
  return rows.map((row) => mapSearchRow(row, query));
}

function searchKnowledge(db, payload = {}) {
  const query = String(payload.query || '').trim();
  if (!query) return [];
  if (!tableExists(db, 'knowledge_search_rows')) return [];
  const folderId = String(payload.folderId || '').trim();
  const limit = normalizeSearchLimit(payload.limit);
  if (query.length < 3 || !tableExists(db, 'knowledge_search_fts')) {
    return likeSearch(db, query, folderId, limit);
  }
  try {
    const results = ftsSearch(db, query, folderId, limit);
    return results.length ? results : likeSearch(db, query, folderId, limit);
  } catch {
    return likeSearch(db, query, folderId, limit);
  }
}

module.exports = {
  createKnowledgeSearchSchema,
  backfillKnowledgeSearch,
  removeDocumentSearch,
  reindexDocumentSearch,
  syncDocumentSearchMeta,
  searchKnowledge,
  _internals: {
    escapeLikeQuery,
    escapeFtsQuery,
    buildSnippet,
    normalizeSearchLimit,
  },
};
