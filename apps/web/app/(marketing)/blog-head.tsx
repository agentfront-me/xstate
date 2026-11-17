import { tags } from '@/lib/blog'

/** The page title, the feeds and the tag filter, shared with the tag pages. */
export function BlogHead({ active }: { active: string | null }) {
  return (
    <div className="blog-head">
      <div className="blog-title">
        <h1>{active ? `Posts tagged ${active}` : 'Blog'}</h1>
        <p className="muted">Notes on email, domains and AI agents from the people building xstate.</p>
      </div>
      <div className="blog-tools small mono">
        <nav className="tags" aria-label="Tags">
          <a href="/blog" aria-current={active === null ? 'page' : undefined}>
            all
          </a>
          {tags().map(({ tag }) => (
            <a key={tag} href={`/blog/tags/${tag}`} aria-current={active === tag ? 'page' : undefined}>
              {tag}
            </a>
          ))}
        </nav>
        <span className="feeds muted">
          <a href="/blog/feed.json">feed.json</a>
          <a href="/blog/rss.xml">rss</a>
          <a href="/changelog">changelog</a>
        </span>
      </div>
    </div>
  )
}
