import { NeutralVideoSkin, Video, VideoPlayer, usePlayer } from "@videojs/react/video";
import "@videojs/react/video/neutral-skin.css";

type InlineVideoPlayerProps = {
  src: string;
  className?: string;
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

export function InlineVideoPlayer({ src, className }: InlineVideoPlayerProps) {
  return (
    <VideoPlayer>
      <NeutralVideoSkin className={`pepper-video-skin ${className ?? ""}`} style={{ width: "100%", aspectRatio: "16 / 9" }}>
        <Video
          key={src}
          className="video-fade-in"
          src={src}
          playsInline
          preload="metadata"
          onLoadedData={(event) => event.currentTarget.classList.add("video-loaded")}
        />
        <PlaybackSpeedButton />
      </NeutralVideoSkin>
    </VideoPlayer>
  );
}
