import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolves `requestPath` inside an app's install directory. Symlinks are
 * resolved on both sides, so a link in a cloned repo can't point outside the
 * app. Returns the real file path, or `null` when the file is missing, isn't a
 * regular file, or lies outside `root`.
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
  try {
    return statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}
