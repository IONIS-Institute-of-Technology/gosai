/**
 * Graceful audio loader. Attempts to fetch a sound file from the app's
 * static assets; if the file is missing or fails to decode the playback
 * helper becomes a no-op. The user can drop matching .mp3/.wav files into
 * `assets/audio/` later without code changes.
 *
 * Why `import.meta.url`? When the bundle is dynamic-imported by the app-host
 * from `/v1/apps/<slug>/static/dist/main.js`, `import.meta.url` resolves to
 * that absolute URL. `new URL('../assets/audio/...', import.meta.url)` then
 * yields the correct fully-qualified static URL without us having to know
 * the slug or the server origin.
 */

export interface SoundHandle {
  /** Play (or restart) the sound. Does nothing if the file failed to load. */
  play(): void;
  /** Whether the underlying audio element loaded successfully. */
  readonly loaded: boolean;
}

const SILENT: SoundHandle = {
  play() {},
  get loaded() {
    return false;
  },
};

/**
 * Resolve a relative asset path to an absolute URL using `import.meta.url`
 * (the URL of the built bundle, i.e. `dist/main.js`). Assets live one level
 * up at `../assets/...`.
 */
function resolveAssetUrl(relPath: string): string {
  try {
    return new URL(`../assets/${relPath}`, import.meta.url).href;
  } catch {
    return relPath;
  }
}

/**
 * Try to load `assets/<relPath>` as a playable HTMLAudioElement. Returns a
 * handle that may or may not actually play, depending on whether the file
 * was found. All failure paths are silent on purpose.
 */
export function loadSound(relPath: string): SoundHandle {
  const url = resolveAssetUrl(relPath);
  let audio: HTMLAudioElement;
  try {
    audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
  } catch {
    return SILENT;
  }

  let loaded = false;
  let failed = false;

  audio.addEventListener('canplaythrough', () => {
    loaded = true;
  });
  audio.addEventListener('error', () => {
    failed = true;
  });

  return {
    play() {
      if (failed) return;
      try {
        audio.currentTime = 0;
        // play() returns a promise that may reject if the file isn't ready
        // or autoplay is blocked. We swallow rejection silently.
        const p = audio.play();
        if (p && typeof p.then === 'function') {
          p.catch(() => undefined);
        }
      } catch {
        // Ignore any sync throw (e.g. element removed).
      }
    },
    get loaded() {
      return loaded;
    },
  };
}
