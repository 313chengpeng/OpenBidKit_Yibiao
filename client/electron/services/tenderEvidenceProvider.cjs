function normalizeRequest(value = {}) {
  return {
    query: String(value.query || '').trim(),
    categories: Array.isArray(value.categories) ? value.categories.map((item) => String(item || '').trim()).filter(Boolean) : [],
    sectionIds: Array.isArray(value.sectionIds) ? value.sectionIds.map((item) => String(item || '').trim()).filter(Boolean) : [],
    limit: Math.max(1, Math.min(100, Number(value.limit) || 10)),
  };
}

function normalizeHit(value, index) {
  const content = String(value?.content || '').trim();
  if (!content) return null;
  return {
    id: String(value?.id || `tender-evidence-${index + 1}`),
    content,
    section: String(value?.section || '').trim(),
    page: String(value?.page || '').trim(),
    score: Number.isFinite(Number(value?.score)) ? Number(value.score) : undefined,
    authority: 'tender',
  };
}

function createTenderEvidenceProvider({ searchIndex } = {}) {
  return {
    getCapabilities() {
      return { available: typeof searchIndex === 'function', indexed: typeof searchIndex === 'function', authority: 'tender' };
    },
    async search(request) {
      const normalized = normalizeRequest(request);
      if (!normalized.query || typeof searchIndex !== 'function') {
        return { available: false, authority: 'tender', hits: [] };
      }
      const result = await searchIndex(normalized);
      const hits = (Array.isArray(result?.hits) ? result.hits : Array.isArray(result) ? result : [])
        .map(normalizeHit)
        .filter(Boolean)
        .slice(0, normalized.limit);
      return { available: true, authority: 'tender', hits };
    },
  };
}

module.exports = { createTenderEvidenceProvider, _internals: { normalizeRequest, normalizeHit } };
