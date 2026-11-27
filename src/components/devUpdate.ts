import type { PepperUpdate } from "./updateProgress";

// Development-only simulation; never invokes the native updater or restarts Pepper.
export function createDevUpdate(): PepperUpdate {
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  return {
    currentVersion: "0.1.0", version: "0.2.0", preview: true,
    async download(onEvent) {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      for (let step = 0; step < 20; step++) {
        await pause(180);
        onEvent?.({ event: "Progress", data: { chunkLength: 5 } });
      }
      onEvent?.({ event: "Finished" });
      await pause(800);
    },
    async install() { await pause(1200); },
    async close() {},
  };
}
