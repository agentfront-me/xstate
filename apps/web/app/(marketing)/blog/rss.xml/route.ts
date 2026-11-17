// /blog/rss.xml: the blog as RSS 2.0 (lib/blog.ts).
import { rssFeed } from '@/lib/blog'

export const revalidate = false

export function GET() {
  return new Response(rssFeed(), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
