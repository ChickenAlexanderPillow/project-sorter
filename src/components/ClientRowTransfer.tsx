import "./ClientRowTransfer.css";

export type ClientTransferProgress = { current: string; bytes_done: number; bytes_total: number };

export function ClientRowTransfer({ progress }: { progress: ClientTransferProgress }) {
  const filename = progress.current.split(/[\\/]/).pop();
  const percent = progress.bytes_total > 0 ? Math.min(100, progress.bytes_done / progress.bytes_total * 100) : 0;
  return <div className="client-row-transfer" role="status" aria-label="Transferring files">
    <div className="client-row-transfer-content">
      <span className="client-row-transfer-file" title={progress.current}>{filename || "Preparing files…"}</span>
      <progress className="frameio-upload-progress" value={percent} max={100} aria-label="File transfer progress" />
    </div>
  </div>;
}
