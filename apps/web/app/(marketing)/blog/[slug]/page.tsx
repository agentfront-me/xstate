// /blog/<slug>: one post. A reading column with the table of contents beside it on wide screens, then the posts
// either side. The same post is at /blog/<slug>.md and /blog/<slug>.json, and here with Accept: text/markdown or
// application/json (proxy.ts).
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getMDXComponents } from '@/components/mdx'
import { getPost, neighbours, posts, SITE } from '@/lib/blog'
import { Cta, SiteFooter, SiteHeader } from '../../chrome'

type Props = { params: Promise<{ slug: string }> }

export default async function PostPage({ params }: Props) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()

  const { newer, older } = neighbours(slug)
  const MDX = post.entry.body
  const toc = post.entry.toc.filter((t) => t.depth <= 3)
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.summary,
    datePublished: post.date,
    dateModified: post.updated ?? post.date,
    author: { '@type': 'Organization', name: post.author, url: SITE },
    publisher: { '@type': 'Organization', name: 'xstate', url: SITE },
    mainEntityOfPage: `${SITE}${post.url}`,
    keywords: post.tags.join(', '),
  }

  return (
    <div className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      <SiteHeader />

      <article className="article">
        <header className="article-head">
          <a href="/blog" className="small muted mono">
            ← Blog
          </a>
          <h1>{post.title}</h1>
          <p className="article-summary muted">{post.summary}</p>
          <div className="article-meta small muted mono">
            <time dateTime={post.date}>{post.date}</time>
            <span>{post.minutes} min read</span>
            <span className="tags">
              {post.tags.map((t) => (
                <a key={t} href={`/blog/tags/${t}`}>
                  {t}
                </a>
              ))}
            </span>
            <span>{post.author}</span>
            {post.updated && <span>updated {post.updated}</span>}
            {post.draft && <span className="draft">draft</span>}
          </div>
        </header>

        <div className="article-grid">
          <div className="prose article-body">
            <MDX components={getMDXComponents()} />
          </div>

          <aside className="article-side small">
            {toc.length > 0 && (
              <nav aria-label="On this page" className="toc">
                <span className="faint mono">On this page</span>
                {toc.map((t) => (
                  <a key={t.url} href={t.url} className={t.depth > 2 ? 'sub' : undefined}>
                    {t.title}
                  </a>
                ))}
              </nav>
            )}
            <div className="as-markdown">
              <span className="faint mono">For agents</span>
              <a href={`${post.url}.md`} className="mono">
                {post.url}.md
              </a>
              <code className="mono faint">{`curl -H 'Accept: text/markdown' ${SITE.replace('https://', '')}${post.url}`}</code>
            </div>
          </aside>
        </div>

        <nav className="pager" aria-label="More posts">
          {older ? (
            <a href={older.url}>
              <span className="small faint mono">← Older</span>
              <span>{older.title}</span>
            </a>
          ) : (
            <span />
          )}
          {newer ? (
            <a href={newer.url} className="next">
              <span className="small faint mono">Newer →</span>
              <span>{newer.title}</span>
            </a>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <Cta />
      <SiteFooter />
    </div>
  )
}

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()
  return {
    title: post.title,
    description: post.summary,
    authors: [{ name: post.author }],
    keywords: post.tags,
    alternates: {
      canonical: post.url,
      types: { 'text/markdown': `${post.url}.md`, 'application/json': `${post.url}.json`, 'application/feed+json': '/blog/feed.json' },
    },
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.summary,
      url: post.url,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      tags: post.tags,
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.summary },
    robots: post.draft ? { index: false } : undefined,
  }
}
