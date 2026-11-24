import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const CACHE_DIR = process.env.PITWALL_CACHE ?? path.join(ROOT, '.cache');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');
