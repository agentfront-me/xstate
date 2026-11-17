// /changelog: every release on one page, newest first, each with its own anchor (/changelog#2026-11-16). Also at
// /changelog.md and /changelog.json, and here with Accept: text/markdown or application/json (proxy.ts).
import type { Metadata } from 'next'
import { getMDXComponents } from '@/components/mdx'
import { releases } from '@/lib/blog'
import { Cta, SiteFooter, SiteHeader } from '../chrome'

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'What changed in xstate, newest first.',
  alternates: { canonical: '/changelog', types: { 'text/markdown': '/changelog.md', 'application/json': '/changelog.json' } },
}

export default function Changelog() {
  return (
    <div className="page">
      <SiteHeader />
      <div className="blog-head">
        <div className="blog-title">
          <h1>Changelog</h1>
          <p className="muted">What changed in xstate, newest first.</p>
        </div>
        <div className="blog-tools small mono">
          <span className="feeds muted">
            <a href="/changelog.md">changelog.md</a>
            <a href="/changelog.json">changelog.json</a>
            <a href="/blog">blog</a>
          </span>
        </div>
      </div>

      <div className="releases">
        {releases.map((r) => {
          const MDX = r.entry.body
          return (
            <section className="release" id={r.slug} key={r.slug} aria-labelledby={`${r.slug}-h`}>
              <a href={`#${r.slug}`} className="small muted mono release-date">
                <time dateTime={r.date}>{r.date}</time>
              </a>
              <div>
                <h2 id={`${r.slug}-h`}>{r.title}</h2>
                <div className="prose article-body">
                  <MDX components={getMDXComponents()} />
                </div>
              </div>
            </section>
          )
        })}
      </div>

      <Cta />
      <SiteFooter />
    </div>
  )
}
