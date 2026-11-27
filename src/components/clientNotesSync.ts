export type NoteReference = { id: string; relative_path: string; name: string; timecode: string; end_timecode?: string; text?: string };
export type NoteTask = { id: string; text: string; completed: boolean; references: NoteReference[] };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Rebase edits made during an outstanding request onto its returned snapshot.
// Stable IDs preserve focus and the blank input row in the component.
export function rebaseNotes(base: NoteTask[], local: NoteTask[], remote: NoteTask[]): NoteTask[] {
  const result = remote.map(task => ({ ...task }));
  for (const before of base) {
    if (!local.some(task => task.id === before.id)) {
      const index = result.findIndex(task => task.id === before.id);
      if (index >= 0 && same(result[index], before)) result.splice(index, 1);
    }
  }
  for (const task of local) {
    const before = base.find(item => item.id === task.id);
    if (same(task, before)) continue;
    const index = result.findIndex(item => item.id === task.id);
    if (index < 0 || !before) {
      if (index < 0) result.push(task); else result[index] = task;
      continue;
    }
    const merged = { ...result[index] };
    if (task.text !== before.text) merged.text = task.text;
    if (task.completed !== before.completed) merged.completed = task.completed;
    const refs = [...merged.references];
    for (const old of before.references) {
      if (!task.references.some(ref => ref.id === old.id)) {
        const ri = refs.findIndex(ref => ref.id === old.id);
        if (ri >= 0 && same(refs[ri], old)) refs.splice(ri, 1);
      }
    }
    for (const ref of task.references) {
      const old = before.references.find(item => item.id === ref.id);
      if (same(ref, old)) continue;
      const ri = refs.findIndex(item => item.id === ref.id);
      if (ri < 0) refs.push(ref);
      else refs[ri] = { ...refs[ri], ...Object.fromEntries(Object.entries(ref).filter(([key, value]) => !old || value !== old[key as keyof NoteReference])) };
    }
    merged.references = refs;
    result[index] = merged;
  }
  const reordered = !same(base.filter(t => local.some(l => l.id === t.id)).map(t => t.id), local.filter(t => base.some(b => b.id === t.id)).map(t => t.id));
  if (reordered) {
    const order = local.map(t => t.id);
    result.sort((a, b) => (order.indexOf(a.id) < 0 ? Infinity : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? Infinity : order.indexOf(b.id)));
  }
  return result;
}

type Transport = {
  load: () => Promise<NoteTask[]>;
  save: (tasks: NoteTask[], base: NoteTask[]) => Promise<NoteTask[]>;
};
export class ClientNotesSync {
  private base: NoteTask[] | null = null;
  private local: NoteTask[] = [];
  private running = false;
  private stopped = false;
  private changedAt = 0;
  private dirtySince = 0;
  private transport: Transport;
  private onTasks: (tasks: NoteTask[]) => void;
  private onStatus: (status: 'saved' | 'saving' | 'error', error: string) => void;
  constructor(transport: Transport, onTasks: (tasks: NoteTask[]) => void,
    onStatus: (status: 'saved' | 'saving' | 'error', error: string) => void) {
    this.transport = transport;
    this.onTasks = onTasks;
    this.onStatus = onStatus;
  }

  update(tasks: NoteTask[]) {
    if (same(tasks, this.local)) return;
    if (same(this.local, this.base)) this.dirtySince = Date.now();
    this.local = tasks;
    this.changedAt = Date.now();
    this.onStatus('saving', '');
  }

  async refresh(force = false): Promise<void> {
    if (this.running || this.stopped) return;
    const dirty = this.base !== null && !same(this.local, this.base);
    if (dirty && !force && Date.now() - this.changedAt < 350 && Date.now() - this.dirtySince < 1000) return;
    this.running = true;
    const submitted = this.local;
    try {
      const remote = dirty ? await this.transport.save(submitted, this.base!) : await this.transport.load();
      const next = dirty ? rebaseNotes(submitted, this.local, remote) : this.base === null ? remote : rebaseNotes(this.base, this.local, remote);
      const changed = this.base === null || !same(next, this.local);
      this.base = remote;
      this.local = next;
      if (!this.stopped) {
        if (changed) this.onTasks(next);
        this.onStatus(same(next, remote) ? 'saved' : 'saving', '');
      }
    } catch (reason) {
      if (!this.stopped) this.onStatus('error', String(reason));
    } finally {
      this.running = false;
      // Leaving a client must not discard its debounce or edits made during a save.
      if (this.stopped && this.base !== null && !same(this.local, this.base)) {
        const pending = this.local;
        try { this.base = await this.transport.save(pending, this.base); } catch (reason) { console.error('Could not finish saving client notes', reason); }
      }
    }
  }

  stop() {
    // Start the final save before suppressing UI callbacks.
    if (!this.running) void this.refresh(true);
    this.stopped = true;
  }
}
