const { ipcMain } = require('electron');

function registerDifyKnowledgeIpc({ difyKnowledgeService }) {
  ipcMain.handle('dify-knowledge:get-status', () => difyKnowledgeService.getStatus());
  ipcMain.handle('dify-knowledge:list-datasets', () => difyKnowledgeService.listDatasets());
}

module.exports = { registerDifyKnowledgeIpc };
