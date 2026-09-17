/**
 * Image and video elements for one layer, keyed by URL. Each layer owns a
 * cache: videos it stops drawing are paused, and everything is released when
 * the layer stops, so no playback outlives it.
 */

/** The parts of a video element the cache drives. */
export interface VideoLike {
  src: string;
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  preload: string;
  readonly paused: boolean;
  readonly readyState: number;
  readonly videoWidth: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
}

/** The parts of an image element the cache drives. */
export interface ImageLike {
  src: string;
  readonly complete: boolean;
  readonly naturalWidth: number;
  removeAttribute(name: string): void;
}

export interface MediaFactory<V extends VideoLike, I extends ImageLike> {
  createVideo(): V;
  createImage(): I;
}

const HAVE_CURRENT_DATA = 2;

export class MediaCache<
  V extends VideoLike = HTMLVideoElement,
  I extends ImageLike = HTMLImageElement,
> {
  private readonly images = new Map<string, I>();
  private readonly videos = new Map<string, V>();
  /** Videos drawn since the last {@link pauseUnused}. */
  private readonly used = new Set<V>();

  constructor(private readonly factory: MediaFactory<V, I>) {}

  image(url: string): I {
    let img = this.images.get(url);
    if (!img) {
      img = this.factory.createImage();
      img.src = url;
      this.images.set(url, img);
    }
    return img;
  }

  /** True once an image has decoded and can be drawn. */
  static imageReady(img: ImageLike): boolean {
    return img.complete && img.naturalWidth > 0;
  }

  /** A muted, looping video. Created paused; {@link playing} starts it. */
  video(url: string): V {
    let video = this.videos.get(url);
    if (!video) {
      video = this.factory.createVideo();
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = url;
      this.videos.set(url, video);
    }
    return video;
  }

  /**
   * Keeps a video playing because the layer draws it this frame. Returns
   * whether it has a frame to draw.
   */
  playing(video: V): boolean {
    this.used.add(video);
    if (video.paused) video.play().catch(() => undefined);
    return video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0;
  }

  /** Pauses the videos that weren't drawn since the previous call. Call once per frame. */
  pauseUnused(): void {
    for (const video of this.videos.values()) {
      if (!this.used.has(video) && !video.paused) video.pause();
    }
    this.used.clear();
  }

  /** Pauses every video, e.g. while the compositor is suspended. */
  pauseAll(): void {
    for (const video of this.videos.values()) video.pause();
    this.used.clear();
  }

  /** Stops every video and drops every element so the browser frees their media. */
  release(): void {
    for (const video of this.videos.values()) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    for (const img of this.images.values()) img.removeAttribute('src');
    this.videos.clear();
    this.images.clear();
    this.used.clear();
  }
}

/** A cache that creates real DOM elements. */
export function createMediaCache(): MediaCache {
  return new MediaCache({
    createVideo: () => document.createElement('video'),
    createImage: () => new Image(),
  });
}
