// /blog/feed.json: the blog as a JSON Feed (lib/blog.ts). Also what /blog returns with Accept: application/json.
import { jsonFeed } from '@/lib/blog'

export const revalidate = false

export function GET() {
  return Response.json(jsonFeed(), { headers: { 'Content-Type': 'application/feed+json; charset=utf-8' } })
}
