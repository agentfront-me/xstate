// /llms.txt: an index of the docs for agents, one line per page linking to its Markdown.
import { llmsIndex } from '@/lib/source'

export const revalidate = false

export function GET() {
  return new Response(llmsIndex(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
