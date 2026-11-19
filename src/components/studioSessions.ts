import { invoke } from '@tauri-apps/api/core';

export type StudioSession = { event_id: string; title: string; url: string; status?: string | null };
type Remote = Record<string, unknown>;
export const parseStudioSession = (value: Remote): StudioSession => {
  const event = value.event && typeof value.event === 'object' ? value.event as Remote : value;
  return {
    event_id: String(event.id ?? event.eventId ?? ''),
    title: String(event.title ?? 'Untitled session'),
    url: String(event.url ?? ''),
    status: typeof event.status === 'string' ? event.status : null,
  };
};


export async function createStudioSession(title: string): Promise<StudioSession> {
  const created = parseStudioSession(await invoke<Remote>('restream_create_studio', { title: title.trim() }));
  if (!created.event_id || !created.url) throw Error('Restream returned no usable Studio URL.');
  return created;
}
