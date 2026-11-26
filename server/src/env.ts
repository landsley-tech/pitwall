// loads settings from pitwall/.env if there is one (F1TV_TOKEN, MULTIVIEWER_URL, ...).
// imported first so everything else sees them. anything already set in the
// shell wins over the file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
try {
  process.loadEnvFile(file);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[env] couldn't read ${file}:`, (err as Error).message);
}
