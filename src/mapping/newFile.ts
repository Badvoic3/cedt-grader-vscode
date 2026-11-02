import { stat, writeFile } from 'node:fs/promises';

export type CreateChoice = 'open' | 'overwrite' | 'cancel';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an empty file at `path`. If it exists, `ask` decides; nothing is
 * ever overwritten without an explicit 'overwrite'.
 */
export async function createFileNoOverwrite(path: string, ask: () => Promise<CreateChoice>): Promise<'created' | CreateChoice> {
  if (await exists(path)) {
    const choice = await ask();
    if (choice === 'overwrite') await writeFile(path, '');
    return choice;
  }
  await writeFile(path, '', { flag: 'wx' }); // fails instead of overwriting if it appeared meanwhile
  return 'created';
}

export { exists as pathExists };
