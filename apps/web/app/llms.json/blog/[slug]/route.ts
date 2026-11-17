// /blog/<slug>.json (rewritten here by next.config.ts): one post as JSON, with its Markdown.
import { notFound } from 'next/navigation'
import { getPost, postJson, posts } from '@/lib/blog'

export const revalidate = false

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug)
  if (!post) notFound()
  return Response.json(postJson(post))
}

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }))
}
