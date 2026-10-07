import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { ChatImage } from '../types/types';

/**
 * Resolves one chat image to a displayable src. Inline data URLs are used
 * directly; path-based attachments are fetched as blobs (a bare <img src>
 * cannot carry the auth header) — first from the global assets route
 * (`~/.cloudcli/assets`), then from the project files route as a fallback for
 * sessions recorded before attachments moved to the global store.
 */
export function useChatImageSrc(image: ChatImage, projectId?: string | null): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(image.data || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (image.data) {
      setSrc(image.data);
      setFailed(false);
      return;
    }

    const imagePath = image.path;
    if (!imagePath) {
      setSrc(null);
      setFailed(true);
      return;
    }

    const filename = imagePath.split(/[\\/]/).pop() || '';
    const candidateUrls = [
      `/api/assets/images/${encodeURIComponent(filename)}`,
      ...(projectId
        ? [`/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(imagePath)}`]
        : []),
    ];

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      setSrc(null);
      setFailed(false);
      for (const url of candidateUrls) {
        try {
          const response = await authenticatedFetch(url, { signal: controller.signal });
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          // Cleanup уже мог отработать, пока шёл await: тогда object URL
          // создастся сиротой и не будет отозван.
          if (controller.signal.aborted) {
            return;
          }
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
        }
      }
      setSrc(null);
      setFailed(true);
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [image.data, image.path, projectId]);

  return { src, failed };
}
