import { ulid } from 'ulid'

/** Generate a new ULID (monotonically sortable, URL-safe, 26-char string). */
export function newUlid(): string {
  return ulid()
}
