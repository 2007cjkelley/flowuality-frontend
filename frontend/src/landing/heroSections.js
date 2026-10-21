// The landing page's "problem → reveal" sections, in page order. Each one
// shows `problem` alongside its recording, then flips the caption to `reveal`
// once playback passes `revealAt` (seconds into the video), and flips back
// when the loop restarts.
//
// To add or re-time a recording: drop the files in frontend/public/landing/
// and edit this list -- nothing else. `revealAt` is the moment the payoff is
// visible on screen (e.g. the frame where the items finish flowing into open
// space), read off the video in any player. Until a video file exists the
// section is hidden entirely, so an entry can wait here for its recording.
//
// `webm` is optional: when present it's offered first (smaller), with the MP4
// as the fallback every browser can play.
//
// `aspectRatio` is the video's own width / height, so its frame is never
// cropped; omit it for the 16 / 10 default.
//
// Entry shape: { id, problem, reveal, mp4, webm, poster, aspectRatio,
// revealAt, alt }. Empty in this copy: no recordings ship with it.

const heroSections = [];

export default heroSections;
