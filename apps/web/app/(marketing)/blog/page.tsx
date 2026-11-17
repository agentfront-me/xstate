// /blog: every post, grouped by year, newest first, with the tags to filter by.
import type { Metadata } from 'next'
import { posts } from '@/lib/blog'
import { Cta, SiteFooter, SiteHeader } from '../chrome'
import { BlogHead } from '../blog-head'
import { PostList } from '../post-list'

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Notes on email, domains and AI agents from the people building xstate.',
  alternates: {
    canonical: '/blog',
    types: { 'application/feed+json': '/blog/feed.json', 'application/rss+xml': '/blog/rss.xml' },
  },
}

export default function BlogIndex() {
  return (
    <div className="page">
      <SiteHeader />
      <BlogHead active={null} />
      <ByYear />
      <Cta />
      <SiteFooter />
    </div>
  )
}

function ByYear() {
  const years = [...new Set(posts.map((p) => p.date.slice(0, 4)))]
  return (
    <>
      {years.map((y) => (
        <section className="year" key={y} aria-label={y}>
          <h2 className="small faint mono">{y}</h2>
          <PostList posts={posts.filter((p) => p.date.startsWith(y))} showYear={false} />
        </section>
      ))}
    </>
  )
}
