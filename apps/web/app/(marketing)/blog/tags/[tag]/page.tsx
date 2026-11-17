// /blog/tags/<tag>: the posts with one tag. A page per tag, so it is prerendered like the rest of the blog.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { posts, tags } from '@/lib/blog'
import { BlogHead } from '../../../blog-head'
import { Cta, SiteFooter, SiteHeader } from '../../../chrome'
import { PostList } from '../../../post-list'

type Props = { params: Promise<{ tag: string }> }

export default async function TagPage({ params }: Props) {
  const { tag } = await params
  const tagged = posts.filter((p) => p.tags.includes(tag))
  if (!tagged.length) notFound()
  return (
    <div className="page">
      <SiteHeader />
      <BlogHead active={tag} />
      <section className="year">
        <PostList posts={tagged} />
      </section>
      <Cta />
      <SiteFooter />
    </div>
  )
}

export function generateStaticParams() {
  return tags().map(({ tag }) => ({ tag }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params
  return { title: `Posts tagged ${tag}`, alternates: { canonical: `/blog/tags/${tag}` } }
}
