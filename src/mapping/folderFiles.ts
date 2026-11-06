import { readdir } from 'node:fs/promises';
import { EXCLUDED_DIRS } from './findByName';

/**
 * Files below a folder (relative, "/" separators), at most `max`, breadth
 * first. Build and dependency folders are not entered, so a workspace root
 * with a large `node_modules` costs nothing. An unreadable folder is skipped.
 * `enter` replaces that rule for a caller that needs one of those folders.
 */
export async function listFolderFiles(root: string, max: number, enter: (name: string) => boolean = (name) => !EXCLUDED_DIRS.includes(name)): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  for (let i = 0; i < queue.length && out.length < max; i++) {
    const rel = queue[i];
    const entries = await readdir(rel ? `${root}/${rel}` : root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isDirectory()) out.push(path);
      else if (enter(e.name)) queue.push(path);
      if (out.length >= max) break;
    }
  }
  return out;
}
