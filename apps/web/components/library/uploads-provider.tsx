'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LibraryItemSummary } from '@velnox/shared';
import type { ApiFailure } from '@/lib/client-api';
import { uploadToLibrary } from './upload';

/**
 * Uploads to the ISO library, owned by the shell rather than the library page.
 *
 * An upload used to live in the library page's own state, so leaving the page
 * unmounted it and the upload stopped half-way. Here it belongs to the layout
 * every signed-in page shares: moving around Velnox leaves it running, the
 * activity bar at the bottom shows its progress, and the library page reads the
 * same state when you come back.
 *
 * What it cannot survive is the page itself going away — a reload, closing the
 * tab, typing another address. The browser gives no way to carry a file
 * selection across that, so while an upload runs the browser is asked to warn
 * first. A paused or broken upload can be resumed from the library with the
 * same file; the server keeps what it received.
 */

export interface ActiveUpload {
  key: string;
  name: string;
  sent: number;
  total: number;
}

export interface FinishedUpload {
  key: string;
  name: string;
  /** The checksum job that follows a complete upload. */
  jobId: string | null;
  error: ApiFailure | null;
}

interface UploadsContextValue {
  active: ActiveUpload[];
  finished: FinishedUpload[];
  start: (file: File, resume?: LibraryItemSummary) => void;
  pause: (key: string) => void;
  dismiss: (key: string) => void;
}

const UploadsContext = createContext<UploadsContextValue | null>(null);

export function useUploads(): UploadsContextValue {
  const value = useContext(UploadsContext);
  if (!value) throw new Error('useUploads outside UploadsProvider');
  return value;
}

export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [active, setActive] = useState<ActiveUpload[]>([]);
  const [finished, setFinished] = useState<FinishedUpload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const start = useCallback(
    (file: File, resume?: LibraryItemSummary) => {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      setActive((list) => [...list, { key, name: file.name, sent: 0, total: file.size }]);

      void uploadToLibrary({
        file,
        resume,
        signal: controller.signal,
        onProgress: (sent, total) =>
          setActive((list) =>
            list.map((upload) => (upload.key === key ? { ...upload, sent, total } : upload)),
          ),
      }).then((result) => {
        controllers.current.delete(key);
        setActive((list) => list.filter((upload) => upload.key !== key));
        // A pause is the person's own doing, not something to report.
        const paused = !result.ok && result.error.code === 'library.upload_paused';
        if (!paused) {
          setFinished((list) => [
            ...list,
            {
              key,
              name: result.ok ? result.item.filename : file.name,
              jobId: result.ok ? (result.job?.id ?? null) : null,
              error: result.ok ? null : result.error,
            },
          ]);
        }
        router.refresh();
      });
    },
    [router],
  );

  const pause = useCallback((key: string) => controllers.current.get(key)?.abort(), []);
  const dismiss = useCallback(
    (key: string) => setFinished((list) => list.filter((upload) => upload.key !== key)),
    [],
  );

  // Ask before the page goes away while bytes are still being sent.
  useEffect(() => {
    if (active.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need a value set; the text itself is never shown.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active.length]);

  return (
    <UploadsContext.Provider value={{ active, finished, start, pause, dismiss }}>
      {children}
    </UploadsContext.Provider>
  );
}
