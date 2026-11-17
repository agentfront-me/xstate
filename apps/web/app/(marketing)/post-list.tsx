// One row per post: date, title and summary, then its tags and read time. Used on the home page, /blog and the
// tag pages. The whole row is the link to the post; a tag is a link of its own, so it sits outside that link.
import type { Post } from '@/lib/blog'

export function PostList({ posts, showYear = true }: { posts: Post[]; showYear?: boolean }) {
  if (!posts.length) return <p className="small muted posts-empty">No posts yet.</p>
  return (
    <ul className="posts">
      {posts.map((p) => (
        <li className="post" key={p.slug}>
          <time dateTime={p.date} className="small muted mono">
            {showYear ? p.date : p.date.slice(5)}
          </time>
          <a className="post-body" href={p.url}>
            <span className="post-title">
              {p.title}
              {p.draft && <span className="draft mono small">draft</span>}
            </span>
            <span className="small muted">{p.summary}</span>
          </a>
          <span className="post-meta small faint mono">
            {p.tags.slice(0, 2).map((t) => (
              <a key={t} href={`/blog/tags/${t}`} className="tag">
                {t}
              </a>
            ))}
            <span className="read">{p.minutes} min</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
