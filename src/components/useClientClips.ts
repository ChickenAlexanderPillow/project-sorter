import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type ClientClip = { name: string; path: string; size: number; modified_ms: number; sha256: string; published: boolean; current: boolean };

export function useClientClips(clientPath: string, enabled: boolean) {
  const [result, setResult] = useState<{path: string; clips: ClientClip[]}>({path: clientPath, clips: []});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    const update = (clips: ClientClip[]) => setResult(current =>
      current.path === clientPath && current.clips.length === clips.length
        && current.clips.every((clip, index) => {
          const next = clips[index];
          return clip.path === next.path && clip.name === next.name && clip.size === next.size
            && clip.modified_ms === next.modified_ms && clip.sha256 === next.sha256
            && clip.published === next.published && clip.current === next.current;
        }) ? current : { path: clientPath, clips });
    const scan = async () => {
      try {
        const clips = await invoke<ClientClip[]>('list_client_clips', {clientPath});
        if (active) update(clips);
      } catch {
        if (active) update([]);
      } finally {
        if (active) timer = window.setTimeout(() => void scan(), 2500);
      }
    };
    void scan();
    return () => { active = false; window.clearTimeout(timer); };
  }, [clientPath, enabled]);
  return result.path === clientPath ? result.clips : [];
}
