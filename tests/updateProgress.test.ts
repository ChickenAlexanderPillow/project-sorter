import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadVerifiedUpdate, type UpdateProgress } from "../src/components/updateProgress.ts";

test("Finished does not allow installation before signature verification resolves", async () => {
  const states: UpdateProgress[] = [];
  let verified!: () => void;
  let readyToInstall = false;
  const run = downloadVerifiedUpdate({ download: async event => {
    event({ event: "Started", data: { contentLength: 100 } });
    event({ event: "Progress", data: { chunkLength: 25 } });
    event({ event: "Progress", data: { chunkLength: 75 } });
    event({ event: "Finished" });
    await new Promise<void>(resolve => { verified = resolve; });
  } }, state => states.push(state)).then(() => { readyToInstall = true; });
  await Promise.resolve();
  assert.equal(readyToInstall, false);
  assert.deepEqual(states.at(-1), { phase: "verifying", downloaded: 100, total: 100 });
  assert.equal(states[2].downloaded, 25);
  verified();
  await run;
  assert.equal(readyToInstall, true);
});

test("signature failure after Finished rejects rather than allowing installation", async () => {
  let readyToInstall = false;
  await assert.rejects(downloadVerifiedUpdate({ download: async event => {
    event({ event: "Finished" });
    throw new Error("Invalid signature");
  } }, () => {}).then(() => { readyToInstall = true; }), /Invalid signature/);
  assert.equal(readyToInstall, false);
});

test("missing or zero content length stays indeterminate and a retry resets byte counts", async () => {
  for (const contentLength of [undefined, 0, 80]) {
    const states: UpdateProgress[] = [];
    await downloadVerifiedUpdate({ download: async event => {
      event({ event: "Started", data: { contentLength } });
      event({ event: "Progress", data: { chunkLength: 40 } });
    } }, state => states.push(state));
    assert.deepEqual(states.at(-1), { phase: "downloading", downloaded: 40, total: contentLength || undefined });
  }
});
