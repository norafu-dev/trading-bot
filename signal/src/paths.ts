import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Repository root (one level above signal/) */
export const PROJECT_ROOT = resolve(__dirname, '..', '..')

/** Runtime data directory — persists across deploys */
export const DATA_DIR = resolve(PROJECT_ROOT, 'data')
