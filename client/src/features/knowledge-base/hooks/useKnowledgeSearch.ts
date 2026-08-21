import { useEffect, useState } from 'react';
import type { KnowledgeSearchHit } from '../types';

const emptyHits: KnowledgeSearchHit[] = [];

export function useKnowledgeSearch(query: string, options?: { folderId?: string; enabled?: boolean; limit?: number }) {
  const [hits, setHits] = useState<KnowledgeSearchHit[]>(emptyHits);
  const [loading, setLoading] = useState(false);
  const keyword = query.trim();
  const enabled = options?.enabled !== false;
  const folderId = options?.folderId || '';
  const limit = options?.limit;

  useEffect(() => {
    if (!enabled || !keyword) {
      setHits(emptyHits);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void window.yibiao?.knowledgeBase.search({ query: keyword, folderId: folderId || undefined, limit })
        .then((result) => {
          if (!cancelled) setHits(result?.results || emptyHits);
        })
        .catch(() => {
          if (!cancelled) setHits(emptyHits);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, folderId, keyword, limit]);

  return { hits, loading, keyword };
}
