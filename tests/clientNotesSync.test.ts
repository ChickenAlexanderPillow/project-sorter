import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientNotesSync, rebaseNotes, type NoteTask } from '../src/components/clientNotesSync.ts';

const task = (id: string, text = id): NoteTask => ({ id, text, completed: false, references: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('an already open view receives shared changes after a save and edit reversal', async () => {
  let shared = [task('one')];
  let shown: NoteTask[] = [];
  const sync = new ClientNotesSync({ load: async () => shared, save: async tasks => { shared = tasks; return tasks; } }, tasks => { shown = tasks; }, () => {});
  await sync.refresh();
  sync.update([task('one', 'edited')]);
  await sync.refresh(true);
  sync.update([task('one', 'temporary')]);
  sync.update([task('one', 'edited')]);
  shared = [...shared, task('teammate')];
  await sync.refresh();
  assert.deepEqual(shown, shared);
});

test('serializes requests and rebases typing during an outstanding save', async () => {
  const pending = deferred<NoteTask[]>();
  let calls = 0;
  let shown: NoteTask[] = [];
  let submittedBase: NoteTask[] = [];
  const sync = new ClientNotesSync({ load: async () => [task('one')], save: async (_tasks, base) => { calls++; submittedBase = base; return pending.promise; } }, tasks => { shown = tasks; }, () => {});
  await sync.refresh();
  sync.update([task('one', 'first edit')]);
  const saving = sync.refresh(true);
  sync.update([task('one', 'still typing')]);
  await sync.refresh(true);
  assert.equal(calls, 1);
  pending.resolve([task('one', 'first edit'), task('remote')]);
  await saving;
  assert.deepEqual(submittedBase, [task('one')]);
  assert.deepEqual(shown, [task('one', 'still typing'), task('remote')]);
});

test('load and save failures recover without reopening the client', async () => {
  let fail = true;
  let shown: NoteTask[] = [];
  let status = '';
  const sync = new ClientNotesSync({ load: async () => { if (fail) throw Error('offline'); return []; }, save: async tasks => { if (fail) throw Error('offline'); return tasks; } }, tasks => { shown = tasks; }, next => { status = next; });
  await sync.refresh();
  assert.equal(status, 'error');
  fail = false;
  await sync.refresh();
  shown = [task('one')]; // The editor already displays its own input.
  sync.update(shown);
  fail = true;
  await sync.refresh(true);
  assert.equal(status, 'error');
  fail = false;
  await sync.refresh(true);
  assert.equal(status, 'saved');
  assert.deepEqual(shown, [task('one')]);
});

test('leaving flushes edits made during an active save', async () => {
  const pending = deferred<NoteTask[]>();
  const saved: NoteTask[][] = [];
  const sync = new ClientNotesSync({ load: async () => [], save: async tasks => { saved.push(tasks); return saved.length === 1 ? pending.promise : tasks; } }, () => {}, () => {});
  await sync.refresh();
  sync.update([task('one', 'first')]);
  const saving = sync.refresh(true);
  sync.update([task('one', 'last')]);
  sync.stop();
  pending.resolve([task('one', 'first')]);
  await saving;
  assert.deepEqual(saved, [[task('one', 'first')], [task('one', 'last')]]);
});

test('rebasing preserves independent fields, references, remote additions and changed deletions', () => {
  const base = [task('one'), task('two')];
  const local = [{ ...task('one', 'typing'), references: [{ id: 'ref', relative_path: 'clip.mp4', name: 'clip', timecode: '00:10' }] }];
  const remote = [{ ...task('one'), completed: true }, task('two', 'remote edit'), task('three')];
  const merged = rebaseNotes(base, local, remote);
  assert.equal(merged[0].text, 'typing');
  assert.equal(merged[0].completed, true);
  assert.equal(merged[0].references.length, 1);
  assert.deepEqual(merged.slice(1), remote.slice(1));
});

test('polling an unchanged document does not rerender inputs or media markers', async () => {
  let updates = 0;
  const sync = new ClientNotesSync({ load: async () => [task('one')], save: async tasks => tasks }, () => { updates++; }, () => {});
  await sync.refresh();
  await sync.refresh();
  await sync.refresh();
  assert.equal(updates, 1);
});

test('a late poll preserves typing started while the read was outstanding', async () => {
  const pending = deferred<NoteTask[]>();
  let reads = 0;
  let shown: NoteTask[] = [];
  const sync = new ClientNotesSync({ load: async () => ++reads === 1 ? [task('one')] : pending.promise, save: async tasks => tasks }, tasks => { shown = tasks; }, () => {});
  await sync.refresh();
  const polling = sync.refresh();
  sync.update([task('one', 'Typing now')]);
  pending.resolve([task('one'), task('remote')]);
  await polling;
  assert.deepEqual(shown, [task('one', 'Typing now'), task('remote')]);
});

test('continuous typing still saves within one second', async () => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    let saves = 0;
    const sync = new ClientNotesSync({ load: async () => [], save: async tasks => { saves++; return tasks; } }, () => {}, () => {});
    await sync.refresh();
    sync.update([task('one', 'a')]);
    now += 500;
    sync.update([task('one', 'ab')]);
    await sync.refresh();
    assert.equal(saves, 0);
    now += 500;
    sync.update([task('one', 'abc')]);
    await sync.refresh();
    assert.equal(saves, 1);
  } finally { Date.now = realNow; }
});
