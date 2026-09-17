import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Top-level directories the server keeps inside an app's install directory
 * for storage and settings. They are private to the app and its tokens.
 */
const PRIVATE_TOP_LEVEL = new Set(['_data', '_config']);

/**
 * Resolves `requestPath` inside an app's install directory. Symlinks are
 * resolved on both sides, so a link in a cloned repo can't point outside the
 * app. Returns the real file path, or `null` when the file is missing, isn't a
 * regular file, lies outside `root`, sits in the app's private data
 * directories, or has a path segment starting with a dot (`.git`, `.env`).
 */
export function resolveStaticFile(root: string, requestPath: string): string | null {
  if (requestPath.includes('\0')) return null;
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(resolve(realRoot, requestPath));
  } catch {
    return null;
  }
  const rel = relative(realRoot, realFile);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!isPublicPath(rel.split(sep))) return null;
  try {
    return statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

function isPublicPath(segments: readonly string[]): boolean {
  const [first] = segments;
  // Case-insensitive filesystems (macOS) resolve `_DATA` to `_data`.
  if (first === undefined || PRIVATE_TOP_LEVEL.has(first.toLowerCase())) return false;
  return segments.every((segment) => !segment.startsWith('.'));
}
