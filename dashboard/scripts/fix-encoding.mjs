// This script is kept for reference in case files get corrupted again.
// Run with: node scripts/fix-encoding.mjs (from dashboard directory)
import { readFileSync, writeFileSync } from 'node:fs'

function fix(path, replacements) {
  let s = readFileSync(path, 'utf8')
  for (const [from, to] of replacements) {
    s = s.split(from).join(to)
  }
  writeFileSync(path, s, 'utf8')
  console.log(`Fixed: ${path}`)
}

// Add replacements here as needed
console.log('No replacements configured. Files look clean.')
