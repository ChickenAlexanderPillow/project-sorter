import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AudioLines, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { mediaKind } from './MediaTypes';
import { previewPreparation } from './previewPreparation';

const timeLabel = (value: number) => {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Dialog-only player: the picture and controls occupy separate, fixed rows. */
export function CopyMediaPreview({ path, name }: { path: string; name: string }) {
  const kind = mediaKind(path);
  const media = useRef<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((node: HTMLVideoElement | HTMLAudioElement | null) => {
    if (media.current && media.current !== node) media.current.pause();
    media.current = node;
  }, []);
  const [prepared, setPrepared] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const playable = kind === 'audio' || kind === 'video';

  useEffect(() => {
    let active = true;
    setPrepared(false); setFailed(false); setPlaying(false); setDuration(0); setPosition(0);
    if (kind) void previewPreparation.prepare(path)
      .then(() => { if (active) setPrepared(true); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; media.current?.pause(); };
  }, [path, kind]);

  const events = {
    onLoadedMetadata: () => setDuration(Number.isFinite(media.current?.duration) ? media.current!.duration : 0),
    onDurationChange: () => setDuration(Number.isFinite(media.current?.duration) ? media.current!.duration : 0),
    onTimeUpdate: () => setPosition(media.current?.currentTime || 0),
    onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
    onError: () => { setFailed(true); setPlaying(false); },
  };
  async function togglePlayback() {
    const player = media.current;
    if (!player || failed) return;
    if (player.paused) {
      try { await player.play(); } catch { setPlaying(false); }
    } else player.pause();
  }

  return <>
    <div className="pph-copy-canvas">
      {failed ? <span>Preview unavailable for this file</span>
        : !kind ? <span>No preview available</span>
        : !prepared ? <span>Loading preview…</span>
        : kind === 'video' ? <video ref={attachMedia} src={convertFileSrc(path)} playsInline preload="metadata" muted={muted} aria-label={name} {...events}/>
        : kind === 'audio' ? <><AudioLines size={42} aria-hidden="true"/><audio ref={attachMedia} src={convertFileSrc(path)} preload="metadata" muted={muted} aria-label={name} {...events}/></>
        : <img src={convertFileSrc(path)} alt={name} loading="lazy" onError={() => setFailed(true)}/>}
    </div>
    <div className="pph-copy-playback">
      {playable ? <>
        <button type="button" onClick={() => void togglePlayback()} disabled={!prepared || failed} aria-label={`${playing ? 'Pause' : 'Play'} ${name}`}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
        <span className="pph-copy-time">{timeLabel(position)}</span>
        <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)} disabled={!prepared || failed || !duration} aria-label={`Seek ${name}`} onChange={event => { const value = Number(event.target.value); if (media.current) media.current.currentTime = value; setPosition(value); }}/>
        <span className="pph-copy-time">{timeLabel(duration)}</span>
        <button type="button" disabled={!prepared || failed} onClick={() => setMuted(value => !value)} aria-label={`${muted ? 'Unmute' : 'Mute'} ${name}`}>{muted ? <VolumeX size={15}/> : <Volume2 size={15}/>}</button>
      </> : <span className="pph-copy-preview-type">{kind === 'image' ? 'Image preview' : 'Preview unavailable'}</span>}
    </div>
  </>;
}
