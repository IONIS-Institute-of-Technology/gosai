import { describe, expect, test } from 'bun:test';
import { MediaCache, type ImageLike, type VideoLike } from '../src/shared/media.js';

class FakeVideo implements VideoLike {
  src = '';
  muted = false;
  loop = false;
  playsInline = false;
  preload = '';
  paused = true;
  readyState = 4;
  videoWidth = 320;
  loads = 0;

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  load(): void {
    this.loads += 1;
  }
}

class FakeImage implements ImageLike {
  src = '';
  complete = true;
  naturalWidth = 10;

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

function cache(): MediaCache<FakeVideo, FakeImage> {
  return new MediaCache({ createVideo: () => new FakeVideo(), createImage: () => new FakeImage() });
}

describe('MediaCache', () => {
  test('creates muted looping videos once per URL, paused until drawn', () => {
    const media = cache();
    const video = media.video('a.webm');
    expect(media.video('a.webm')).toBe(video);
    expect(video).toMatchObject({ src: 'a.webm', muted: true, loop: true, paused: true });
    expect(media.playing(video)).toBe(true);
    expect(video.paused).toBe(false);
  });

  test('pauses the videos a frame no longer draws', () => {
    const media = cache();
    const a = media.video('a.webm');
    const b = media.video('b.webm');
    media.playing(a);
    media.playing(b);
    media.pauseUnused();
    expect([a.paused, b.paused]).toEqual([false, false]);

    media.playing(b);
    media.pauseUnused();
    expect([a.paused, b.paused]).toEqual([true, false]);
  });

  test('each layer releases only its own media', () => {
    const game = cache();
    const training = cache();
    const shared = 'signs/Aria/ok.webm';
    const gameVideo = game.video(shared);
    const trainingVideo = training.video(shared);
    expect(gameVideo).not.toBe(trainingVideo);
    game.playing(gameVideo);
    training.playing(trainingVideo);
    const image = game.image('bg.png');

    game.release();
    expect(gameVideo).toMatchObject({ paused: true, src: '', loads: 1 });
    expect(image.src).toBe('');
    expect(trainingVideo).toMatchObject({ paused: false, src: shared });
    // A released cache starts over with fresh elements.
    expect(game.video(shared)).not.toBe(gameVideo);
  });

  test('pauseAll stops playback without dropping elements', () => {
    const media = cache();
    const video = media.video('a.webm');
    media.playing(video);
    media.pauseAll();
    expect(video.paused).toBe(true);
    expect(media.video('a.webm')).toBe(video);
  });

  test('imageReady needs a decoded image', () => {
    expect(MediaCache.imageReady(new FakeImage())).toBe(true);
    expect(MediaCache.imageReady(Object.assign(new FakeImage(), { naturalWidth: 0 }))).toBe(false);
  });
});
