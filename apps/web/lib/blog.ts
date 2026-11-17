// The blog (content/blog) and the changelog (content/changelog): one Markdown file per post or release, compiled
// by fumadocs-mdx like the docs. A file's name is its slug; its frontmatter is checked below so a missing title or
// a bad date fails the build instead of shipping a broken page.
//
// Blog frontmatter:      title, summary, date (YYYY-MM-DD), author, tags [..], updated?, draft?
// Changelog frontmatter: title, summary, date
//
// Drafts (draft: true) show in development and are left out of the built site, the feeds and llms.txt.
import { defineCollections } from 'fumadocs-mdx/macro'

const blogCollection = defineCollections({ type: 'doc', dir: 'content/blog' })
const changelogCollection = defineCollections({ type: 'doc', dir: 'content/changelog' })

type Entry = (typeof blogCollection.entries)[number]

// The files as written, for the Markdown versions and the read time. Bundled at build time: the Worker has no files.
const rawBlog = import.meta.glob<string>('../content/blog/*.md', { query: '?raw', import: 'default', eager: true })
const rawChangelog = import.meta.glob<string>('../content/changelog/*.md', { query: '?raw', import: 'default', eager: true })

export const SITE = 'https://xstate.com'
const SHOW_DRAFTS = process.env.NODE_ENV === 'development'

export type Post = {
  slug: string
  url: string
  title: string
  summary: string
  /** YYYY-MM-DD */
  date: string
  updated?: string
  author: string
  tags: string[]
  draft: boolean
  /** Minutes to read, from the word count at 220 words a minute. */
  minutes: number
  /** The post as written, without frontmatter. */
  markdown: string
  entry: Entry
}

export type Release = Omit<Post, 'author' | 'tags' | 'draft' | 'minutes' | 'updated'>

const stripFrontmatter = (raw: string) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

function str(fm: Record<string, unknown>, key: string, file: string, optional = false): string | undefined {
  const v = fm[key]
  // YAML turns an unquoted 2026-11-16 into a Date.
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (optional && v == null) return undefined
  throw new Error(`${file}: frontmatter "${key}" must be a non-empty string`)
}

function date(fm: Record<string, unknown>, key: string, file: string, optional = false) {
  const v = str(fm, key, file, optional)
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${file}: "${key}" must be YYYY-MM-DD`)
  return v
}

const slugOf = (entry: Entry) => entry.info.path.replace(/\.mdx?$/, '')
const newestFirst = (a: { date: string }, b: { date: string }) => b.date.localeCompare(a.date)

const allPosts: Post[] = blogCollection.entries
  .map((entry) => {
    const fm = entry as unknown as Record<string, unknown>
    const slug = slugOf(entry)
    const file = `content/blog/${entry.info.path}`
    const markdown = stripFrontmatter(rawBlog[`../${file}`] ?? '')
    const tags = fm.tags
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw new Error(`${file}: "tags" must be a list`)
    return {
      slug,
      url: `/blog/${slug}`,
      title: str(fm, 'title', file)!,
      summary: str(fm, 'summary', file)!,
      date: date(fm, 'date', file)!,
      updated: date(fm, 'updated', file, true),
      author: str(fm, 'author', file)!,
      tags: tags.map((t: string) => t.toLowerCase()),
      draft: fm.draft === true,
      minutes: Math.max(1, Math.round(markdown.split(/\s+/).filter(Boolean).length / 220)),
      markdown,
      entry,
    }
  })
  .sort(newestFirst)

/** Published posts, newest first (drafts too in development). */
export const posts = allPosts.filter((p) => SHOW_DRAFTS || !p.draft)

export const getPost = (slug: string) => posts.find((p) => p.slug === slug)

/** Every tag in use, most posts first. */
export function tags() {
  const counts = new Map<string, number>()
  for (const p of posts) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }))
}

/** The posts either side of one: newer and older. */
export function neighbours(slug: string) {
  const i = posts.findIndex((p) => p.slug === slug)
  return { newer: i > 0 ? posts[i - 1] : undefined, older: i >= 0 ? posts[i + 1] : undefined }
}

/** Releases, newest first. A release's slug is its file name and its anchor on /changelog. */
export const releases: Release[] = changelogCollection.entries
  .map((entry) => {
    const fm = entry as unknown as Record<string, unknown>
    const slug = slugOf(entry)
    const file = `content/changelog/${entry.info.path}`
    return {
      slug,
      url: `/changelog#${slug}`,
      title: str(fm, 'title', file)!,
      summary: str(fm, 'summary', file)!,
      date: date(fm, 'date', file)!,
      markdown: stripFrontmatter(rawChangelog[`../${file}`] ?? ''),
      entry,
    }
  })
  .sort(newestFirst)

// Links in the Markdown versions are made absolute, so they work wherever the text ends up.
const absolute = (md: string) => md.replace(/\]\(\//g, `](${SITE}/`)

export function postMarkdown(p: Post) {
  const meta = [p.date, `${p.minutes} min`, p.tags.join(', '), p.author].join(' · ')
  return `# ${p.title}\n\n> ${p.summary}\n\n${meta}\n\n${absolute(p.markdown)}\n`
}

export function postJson(p: Post) {
  return {
    url: `${SITE}${p.url}`,
    title: p.title,
    summary: p.summary,
    date: p.date,
    updated: p.updated ?? null,
    author: p.author,
    tags: p.tags,
    minutes: p.minutes,
    markdown: `${SITE}${p.url}.md`,
    content_markdown: absolute(p.markdown),
  }
}

export function changelogMarkdown() {
  const body = releases.map((r) => `## ${r.date} · ${r.title}\n\n${absolute(r.markdown)}`).join('\n\n')
  return `# Changelog\n\n> What changed in xstate, newest first.\n\n${body}\n`
}

export function changelogJson() {
  return {
    url: `${SITE}/changelog`,
    releases: releases.map((r) => ({ id: r.slug, url: `${SITE}${r.url}`, date: r.date, title: r.title, summary: r.summary, content_markdown: absolute(r.markdown) })),
  }
}

/** JSON Feed 1.1 (https://jsonfeed.org/version/1.1). */
export function jsonFeed() {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'xstate blog',
    home_page_url: `${SITE}/blog`,
    feed_url: `${SITE}/blog/feed.json`,
    description: 'Notes on email, domains and AI agents from the people building xstate.',
    language: 'en',
    items: posts.map((p) => ({
      id: `${SITE}${p.url}`,
      url: `${SITE}${p.url}`,
      title: p.title,
      summary: p.summary,
      content_text: absolute(p.markdown),
      date_published: `${p.date}T00:00:00Z`,
      ...(p.updated ? { date_modified: `${p.updated}T00:00:00Z` } : {}),
      authors: [{ name: p.author }],
      tags: p.tags,
    })),
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const rfc822 = (d: string) => new Date(`${d}T00:00:00Z`).toUTCString()

/** RSS 2.0, for the feed readers that don't read JSON Feed. */
export function rssFeed() {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${xml(p.title)}</title>
      <link>${SITE}${p.url}</link>
      <guid isPermaLink="true">${SITE}${p.url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${xml(p.summary)}</description>
${p.tags.map((t) => `      <category>${xml(t)}</category>`).join('\n')}
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>xstate blog</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml" />
    <description>Notes on email, domains and AI agents from the people building xstate.</description>
    <language>en</language>
${posts[0] ? `    <lastBuildDate>${rfc822(posts[0].date)}</lastBuildDate>\n` : ''}${items}
  </channel>
</rss>
`
}

/** The blog's and changelog's lines for /llms.txt. */
export function llmsBlogSection() {
  const lines = posts.map((p) => `- [${p.title}](${SITE}${p.url}.md): ${p.summary}`)
  return `## Blog\n\n${lines.join('\n')}\n\n## Changelog\n\n- [Changelog](${SITE}/changelog.md): what changed in xstate, newest first\n`
}
