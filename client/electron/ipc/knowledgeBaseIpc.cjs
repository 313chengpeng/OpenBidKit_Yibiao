const { ipcMain } = require('electron');

function registerKnowledgeBaseIpc({ knowledgeBaseService }) {
  ipcMain.handle('knowledge-base:list', () => knowledgeBaseService.list());
  // type 缺省为 document，文档知识库页面无需改动
  ipcMain.handle('knowledge-base:create-folder', (_event, name, type) => knowledgeBaseService.createFolder(name, type || 'document'));
  ipcMain.handle('knowledge-base:rename-folder', (_event, folderId, name) => knowledgeBaseService.renameFolder(folderId, name));
  ipcMain.handle('knowledge-base:reorder-folder', (_event, draggedFolderId, targetFolderId, position) => knowledgeBaseService.reorderFolder(draggedFolderId, targetFolderId, position));
  ipcMain.handle('knowledge-base:delete-folder', (_event, folderId) => knowledgeBaseService.deleteFolder(folderId));
  ipcMain.handle('knowledge-base:delete-document', (_event, documentId) => knowledgeBaseService.deleteDocument(documentId));
  ipcMain.handle('knowledge-base:move-document', (_event, documentId, targetFolderId, targetDocumentId, position) => knowledgeBaseService.moveDocument(documentId, targetFolderId, targetDocumentId, position));
  ipcMain.handle('knowledge-base:upload-documents', (event, folderId) => knowledgeBaseService.uploadDocuments(folderId, event.sender));
  ipcMain.handle('knowledge-base:retry-document', (event, documentId) => knowledgeBaseService.retryDocument(documentId, event.sender));
  // batchSize 已忽略，服务端按模型上下文自动分段匹配
  ipcMain.handle('knowledge-base:start-matching', (event, documentId, batchSize) => knowledgeBaseService.startMatching(documentId, batchSize, event.sender));
  ipcMain.handle('knowledge-base:read-markdown', (_event, documentId) => knowledgeBaseService.readMarkdown(documentId));
  ipcMain.handle('knowledge-base:read-items', (_event, documentId) => knowledgeBaseService.readItems(documentId));
  ipcMain.handle('knowledge-base:read-analysis', (_event, documentId) => knowledgeBaseService.readAnalysis(documentId));

  // ===== 企业图片知识库（v24）：所有通道在 Service/Store 层做企业作用域校验 =====
  ipcMain.handle('knowledge-image:list-folders', () => knowledgeBaseService.list('image'));
  ipcMain.handle('knowledge-image:create-folder', (_event, name) => knowledgeBaseService.createFolder(name, 'image'));
  ipcMain.handle('knowledge-image:rename-folder', (_event, folderId, name) => knowledgeBaseService.renameFolder(folderId, name));
  ipcMain.handle('knowledge-image:delete-folder', (_event, folderId) => knowledgeBaseService.deleteFolder(folderId));
  ipcMain.handle('knowledge-image:list', (_event, folderId) => knowledgeBaseService.listImages(folderId));
  ipcMain.handle('knowledge-image:create', (_event, folderId, payload) => knowledgeBaseService.createImage(folderId, payload));
  ipcMain.handle('knowledge-image:update', (_event, imageId, patch) => knowledgeBaseService.updateImage(imageId, patch));
  ipcMain.handle('knowledge-image:delete', (_event, imageId) => knowledgeBaseService.deleteImage(imageId));
  ipcMain.handle('knowledge-image:get-data-url', (_event, imageId) => knowledgeBaseService.getImageFileDataUrl(imageId));
  ipcMain.handle('knowledge-image:get-thumbnail-url', (_event, imageId) => knowledgeBaseService.getImageThumbnailDataUrl(imageId));
}

module.exports = { registerKnowledgeBaseIpc };
