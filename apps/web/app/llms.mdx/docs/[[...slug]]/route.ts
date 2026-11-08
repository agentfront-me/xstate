// /docs.md and /docs/<page>.md (rewritten here by next.config.ts): one docs page as Markdown, for agents.
import { notFound } from 'next/navigation'
import { pageMarkdown, source } from '@/lib/source'

export const revalidate = false

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) notFound()
  return new Response(pageMarkdown(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}

export function generateStaticParams() {
  return source.generateParams()
}
