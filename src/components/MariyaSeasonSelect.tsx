import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, Plus, RefreshCw } from "lucide-react";

export function useMariyaSeasons(projectRoot: string, active: boolean, refreshKey?: string | null) {
  const [seasons, setSeasons] = useState<string[]>([]);
  const [season, setSeason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(active);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const remembered = useRef(new Map<string, string>());
  const lastCreated = useRef<string | null | undefined>(undefined);
  const requestedSeason = useRef<string | null>(null);
  const operation = useRef(0);
  useEffect(() => {
    remembered.current.clear();
    requestedSeason.current = null;
    lastCreated.current = undefined;
    setSeason("");
    setSeasons([]);
    setError("");
  }, [projectRoot]);
  const selectSeason = (value: string) => {
    remembered.current.set(projectRoot, value);
    setSeason(value);
  };
  useEffect(() => {
    const id = ++operation.current;
    if (!active) { setLoading(false); setCreating(false); return; }
    setLoading(true); setError(""); setSeason(""); setSeasons([]);
    void invoke<string[]>("list_mariya_meets_seasons", { projectRoot }).then(values => {
      if (id !== operation.current) return;
      const preferred = requestedSeason.current || (refreshKey && refreshKey !== lastCreated.current ? refreshKey : remembered.current.get(projectRoot));
      lastCreated.current = refreshKey;
      const next = preferred && values.includes(preferred) ? preferred : values[0] || "";
      requestedSeason.current = null;
      setSeasons(values); selectSeason(next);
    }).catch(error => { if (id === operation.current) setError(String(error)); })
      .finally(() => { if (id === operation.current) { setLoading(false); setCreating(false); } });
    return () => { operation.current++; };
  }, [projectRoot, active, refreshKey, revision]);
  const createSeason = async () => {
    if (loading || creating) return;
    const id = operation.current;
    setCreating(true); setError("");
    try {
      const created = await invoke<string>("create_mariya_meets_season", { projectRoot });
      remembered.current.set(projectRoot, created);
      if (id !== operation.current) return;
      requestedSeason.current = created;
      setRevision(value => value + 1);
      return created;
    } catch (error) {
      if (id === operation.current) { setError(String(error)); setCreating(false); }
    }
  };
  return { seasons, season, setSeason: selectSeason, error, loading, creating, createSeason, retry: () => setRevision(value => value + 1) };
}

const seasonLabel = (value: string) => value.replace(/^SEASON\s+/i, "Season ");

export function MariyaSeasonSelect({ selection }: { selection: ReturnType<typeof useMariyaSeasons> }) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const busy = selection.loading || selection.creating;
  return <div className="mariya-season-picker" aria-busy={busy}>
    <div className="mariya-season-row">
      <span id={`${id}-label`} className="mariya-season-label">Create in</span>
      <div className="mariya-season-choices" role="group" aria-labelledby={`${id}-label`}>
        {selection.seasons.map((season, index) => <label className="mariya-season-choice" key={season}>
          <input type="radio" name={`${id}-season`} value={season} checked={selection.season === season} disabled={busy} onChange={() => selection.setSeason(season)} />
          <span>{seasonLabel(season)}{index === 0 && <small>Latest</small>}</span>
        </label>)}
        {selection.loading && !selection.seasons.length && <span className="mariya-season-status" role="status"><LoaderCircle size={13} className="spinning" />Loading seasons?</span>}
        <button type="button" className="mariya-season-new" disabled={busy} onClick={() => setConfirming(true)} title="Create the next season and select it">
          {selection.creating ? <LoaderCircle size={13} className="spinning" /> : <Plus size={13} />}
          {selection.creating ? "Creating?" : "New season"}
        </button>
      </div>
    </div>
    {confirming && <SeasonConfirmation selection={selection} onClose={() => setConfirming(false)} />}
    {selection.error ? <div className="mariya-season-error" role="alert"><span>{selection.error}</span><button type="button" disabled={busy} onClick={selection.retry}><RefreshCw size={12} />Retry</button></div>
      : !busy && !selection.seasons.length && <p className="mariya-season-hint">Create the first season to add this client.</p>}
  </div>;
}


function SeasonConfirmation({ selection, onClose }: {
  selection: ReturnType<typeof useMariyaSeasons>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const nextNumber = Math.max(0, ...selection.seasons.map(value => Number(value.match(/^SEASON\s+(\d+)$/i)?.[1]) || 0)) + 1;
  const busy = selection.loading || selection.creating;
  const confirm = async () => {
    const created = await selection.createSeason();
    if (created) onClose();
  };
  return createPortal(<dialog ref={dialog} className="season-confirm-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); if (!selection.creating) onClose(); }}>
    <div className="season-confirm-heading"><h2 id={`${id}-title`}>Create a new season?</h2></div>
    <div className="season-confirm-preview"><span>New season</span><strong>{selection.loading ? "Loading?" : `Season ${nextNumber}`}</strong><small>8_Mariya Meets / {selection.loading ? "?" : `SEASON ${nextNumber}`}</small></div>
    {selection.error && <p className="season-confirm-error" role="alert">{selection.error}</p>}
    <div className="season-confirm-actions">
      <button type="button" className="ghost" autoFocus disabled={selection.creating} onClick={onClose}>Cancel</button>
      {selection.error && <button type="button" className="ghost" disabled={busy} onClick={selection.retry}>Retry</button>}
      <button type="button" className="primary" disabled={busy || !!selection.error} onClick={() => void confirm()}>
        {selection.creating && <LoaderCircle size={14} className="season-spin" />}
        {selection.creating ? "Creating?" : `Create Season ${nextNumber}`}
      </button>
    </div>
  </dialog>, document.body);
}
