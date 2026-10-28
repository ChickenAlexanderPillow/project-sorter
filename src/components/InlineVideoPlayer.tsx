import { NeutralVideoSkin, Video, VideoPlayer } from "@videojs/react/video";
import "@videojs/react/video/neutral-skin.css";

type InlineVideoPlayerProps = {
  src: string;
  className?: string;
};

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
      </NeutralVideoSkin>
    </VideoPlayer>
  );
}
