import { useEffect, useRef, useState } from "react";

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// One "problem → reveal" section: a caption beside a looping, muted screen
// recording. The caption shows `problem` until playback passes `revealAt`,
// then `reveal`, and resets when the loop starts over. Config lives in
// heroSections.js. A section whose video doesn't exist yet removes itself
// entirely, so a config entry can sit ready ahead of its recording.
export default function RevealSection({ section }) {
  const { id, problem, reveal, mp4, webm, poster, revealAt, alt, aspectRatio } = section;
  const videoRef = useRef(null);
  const [revealed, setRevealed] = useState(false);
  const [videoMissing, setVideoMissing] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);

  // Track playback position against revealAt. requestVideoFrameCallback is
  // frame-accurate; timeupdate (~4 Hz) is the fallback for browsers without it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || videoMissing || reducedMotion) return undefined;
    const sync = (t) => setRevealed(t >= revealAt);

    if (typeof video.requestVideoFrameCallback === "function") {
      let handle;
      const onFrame = (_now, meta) => {
        sync(meta.mediaTime);
        handle = video.requestVideoFrameCallback(onFrame);
      };
      handle = video.requestVideoFrameCallback(onFrame);
      return () => video.cancelVideoFrameCallback(handle);
    }
    const onTime = () => sync(video.currentTime);
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [revealAt, videoMissing, reducedMotion]);

  // Only play while on screen -- several looping videos decoding off-screen
  // is wasted battery on a phone.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || videoMissing || reducedMotion || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }, { threshold: 0.25 });
    observer.observe(video);
    return () => observer.disconnect();
  }, [videoMissing, reducedMotion]);

  // Reduced motion: no autoplay and no flipping -- show both lines at once.
  const staticCaption = reducedMotion;

  if (videoMissing) return null;

  return (
    <section className="landing-reveal" data-testid={`reveal-section-${id}`}>
      <div className="landing-reveal-caption" data-testid={`reveal-caption-${id}`} data-revealed={revealed ? "true" : "false"}>
        {/* Screen readers get both lines once, rather than an announcement on every loop. */}
        <p className="landing-visually-hidden">{problem} {reveal}</p>
        {staticCaption ? (
          <div aria-hidden="true">
            <p className="landing-caption-line landing-caption-problem landing-caption-static">{problem}</p>
            <p className="landing-caption-line landing-caption-reveal landing-caption-static">{reveal}</p>
          </div>
        ) : (
          <div className="landing-caption-stack" aria-hidden="true">
            <p className={`landing-caption-line landing-caption-problem${revealed ? "" : " is-active"}`}>{problem}</p>
            <p className={`landing-caption-line landing-caption-reveal${revealed ? " is-active" : ""}`}>{reveal}</p>
          </div>
        )}
      </div>

      <div
        className="landing-reveal-media"
        style={aspectRatio ? { "--lp-media-aspect": aspectRatio } : undefined}
      >
        <video
          ref={videoRef}
          className="landing-video"
          poster={poster || undefined}
          autoPlay={!reducedMotion}
          controls={reducedMotion}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={alt}
        >
          {webm && <source src={webm} type="video/webm" />}
          {/* The error event fires on the last <source> once every source has
              failed -- including a missing file, which the Worker's SPA
              fallback answers with index.html rather than a 404. */}
          <source src={mp4} type="video/mp4" onError={() => setVideoMissing(true)} />
        </video>
      </div>
    </section>
  );
}
