const { ipcMain } = require('electron');

function registerAiIpc({ aiService, embeddingService }) {
  ipcMain.handle('ai:chat', (_event, request) => aiService.chat(request));
  ipcMain.handle('ai:request-json', (_event, request) => aiService.requestJson(request));
  ipcMain.handle('ai:test-image-model', (_event, config) => aiService.testImageModel(config));
  if (embeddingService) {
    ipcMain.handle('ai:test-embedding-model', () => embeddingService.testConnection());
    ipcMain.handle('ai:list-embedding-models', (_event, config) => embeddingService.listModels(config));
  }
}

module.exports = {
  registerAiIpc,
};
