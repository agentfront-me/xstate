// /blog/<slug>.md (rewritten here by next.config.ts): one post as Markdown, for agents.
import { notFound } from 'next/navigation'
import { getPost, postMarkdown, posts } from '@/lib/blog'

export const revalidate = false

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug)
  if (!post) notFound()
  return new Response(postMarkdown(post), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }))
}
