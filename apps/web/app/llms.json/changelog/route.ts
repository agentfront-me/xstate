// /changelog.json (rewritten here by next.config.ts): every release as JSON.
import { changelogJson } from '@/lib/blog'

export const revalidate = false

export function GET() {
  return Response.json(changelogJson())
}
