// /changelog.md (rewritten here by next.config.ts): every release as Markdown.
import { changelogMarkdown } from '@/lib/blog'

export const revalidate = false

export function GET() {
  return new Response(changelogMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}
