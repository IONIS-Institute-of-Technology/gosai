/**
 * Lazy image/video element caches keyed by URL. Used by the sign experiences to
 * load character sprites, backgrounds and sign-demonstration videos on demand.
 */

const images = new Map<string, HTMLImageElement>();
const videos = new Map<string, HTMLVideoElement>();

export function getImage(url: string): HTMLImageElement {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img;
}

export function imageReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

export function getVideo(url: string): HTMLVideoElement {
  let video = videos.get(url);
  if (!video) {
    video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    videos.set(url, video);
  }
  return video;
}

/** Ensure a cached video is playing and return whether it has a drawable frame. */
export function ensureVideoPlaying(video: HTMLVideoElement): boolean {
  if (video.paused) void video.play().catch(() => undefined);
  return video.readyState >= 2 && video.videoWidth > 0;
}
