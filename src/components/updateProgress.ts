import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type PepperUpdate = Pick<Update, "version" | "currentVersion" | "download" | "install" | "close"> & { preview?: boolean };

export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total?: number;
}

// download() resolves only after Tauri has checked the release signature.
// Finished means the network transfer ended; it does not mean verification passed.
export async function downloadVerifiedUpdate(
  update: { download: (onEvent: (event: DownloadEvent) => void) => Promise<void> },
  onProgress: (progress: UpdateProgress) => void,
) {
  let downloaded = 0;
  let total: number | undefined;
  onProgress({ phase: "downloading", downloaded });
  await update.download(event => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength && event.data.contentLength > 0 ? event.data.contentLength : undefined;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress({ phase: event.event === "Finished" ? "verifying" : "downloading", downloaded, total });
  });
}
