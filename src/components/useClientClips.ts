import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type ClientClip = { name: string; path: string; size: number; modified_ms: number; sha256: string; published: boolean; current: boolean };

export function useClientClips(clientPath: string, enabled: boolean) {
  const [result, setResult] = useState<{path: string; clips: ClientClip[]}>({path: clientPath, clips: []});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    const scan = async () => {
      try {
        const clips = await invoke<ClientClip[]>('list_client_clips', {clientPath});
        if (active) setResult({path: clientPath, clips});
      } catch {
        if (active) setResult({path: clientPath, clips: []});
      } finally {
        if (active) timer = window.setTimeout(() => void scan(), 2500);
      }
    };
    void scan();
    return () => { active = false; window.clearTimeout(timer); };
  }, [clientPath, enabled]);
  return result.path === clientPath ? result.clips : [];
}
