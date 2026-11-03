import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useMariyaSeasons(projectRoot: string, active: boolean, refreshKey?: string | null) {
  const [seasons, setSeasons] = useState<string[]>([]);
  const [season, setSeason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setSeason(""); setSeasons([]); setError("");
    if (!active) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    void invoke<string[]>("list_mariya_meets_seasons", { projectRoot }).then(values => {
      if (current) { setSeasons(values); setSeason(values[0] || ""); }
    }).catch(error => { if (current) setError(String(error)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectRoot, active, refreshKey]);
  return { seasons, season, setSeason, error, loading };
}

export function MariyaSeasonSelect({ selection }: { selection: ReturnType<typeof useMariyaSeasons> }) {
  return <label className="mariya-season-select">Season
    <select aria-label="Mariya Meets season" value={selection.season} disabled={selection.loading || !selection.seasons.length} onChange={event => selection.setSeason(event.target.value)}>
      {!selection.seasons.length && <option value="">{selection.loading ? "Loading seasons…" : "No seasons available"}</option>}
      {selection.seasons.map(season => <option key={season} value={season}>{season}</option>)}
    </select>
    {selection.error ? <span role="alert">{selection.error}</span> : !selection.loading && !selection.seasons.length && <span>Create a season using New season first.</span>}
  </label>;
}
