import { NeutralVideoSkin, Video, VideoPlayer, usePlayer } from "@videojs/react/video";
import "@videojs/react/video/neutral-skin.css";
import type { MouseEvent } from "react";

type InlineVideoPlayerProps = {
  src: string;
  className?: string;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onError?: () => void;
  compact?: boolean;
};

const PLAYBACK_RATES = [1, 2, 4];

function PlaybackSpeedButton() {
  const player = usePlayer();
  const rate = usePlayer((state) => state.playbackRate);

  return (
    <button
      type="button"
      className="media-button pepper-speed-button"
      aria-label={`Playback speed ${rate}x. Click to change.`}
      title="Change playback speed"
      onClick={(event) => {
        event.stopPropagation();
        const currentIndex = PLAYBACK_RATES.indexOf(rate);
        player.setPlaybackRate(PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length]);
      }}
    >
      {rate}x
    </button>
  );
}

export function InlineVideoPlayer({ src, className, onContextMenu, onError, compact = false }: InlineVideoPlayerProps) {
  return (
    <VideoPlayer>
      <div className={compact ? "pepper-preview-player" : undefined} onContextMenu={onContextMenu}>
        <NeutralVideoSkin className={`pepper-video-skin ${compact ? "pepper-video-compact" : ""} ${className ?? ""}`} style={{ width: "100%", aspectRatio: "16 / 9" }}>
          <Video
            key={src}
            className="video-fade-in"
            src={src}
            playsInline
            preload="metadata"
            onError={onError}
            onLoadedData={(event) => event.currentTarget.classList.add("video-loaded")}
          />
          {!compact && <PlaybackSpeedButton />}
        </NeutralVideoSkin>
      </div>
    </VideoPlayer>
  );
}
