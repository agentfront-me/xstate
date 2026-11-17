// The header, closing call to action and footer every marketing page shares: the home page, the blog and the
// changelog. Links to home-page sections are /#id so they work from any page.
import { SIGNUP_URL } from '@/lib/urls'
import { HeaderActions, ThemeToggle } from './controls'

export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="/">xstate</a>
      <nav aria-label="Primary">
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="/blog">Blog</a>
        <a href="/#faq">FAQ</a>
        <a href="/docs">Docs</a>
      </nav>
      <div className="header-actions">
        <ThemeToggle />
        <HeaderActions />
      </div>
    </header>
  )
}

export function Cta() {
  return (
    <section className="cta" aria-labelledby="cta-h">
      <div className="cta-copy">
        <h2 id="cta-h">Connect a domain. Inbox in minutes.</h2>
        <p className="small muted">No card on the free plan. Export everything, any time.</p>
      </div>
      <div className="row">
        <a href={SIGNUP_URL} className="btn btn-solid">
          Start free
        </a>
        <a href="/docs/quickstart" className="btn">
          Read the quickstart
        </a>
      </div>
    </section>
  )
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-cols">
        <div>
          <span style={{ fontSize: 14 }}>xstate</span>
          <span className="muted">Business email for the AI-native team</span>
        </div>
        <div>
          <span className="muted">Product</span>
          <a href="/#features">Features</a>
          <a href="/#pricing">Pricing</a>
          <a href="/docs/quickstart">Quickstart</a>
          <a href="/changelog">Changelog</a>
        </div>
        <div>
          <span className="muted">Developers</span>
          <a href="/docs">Docs</a>
          <a href="/docs/mcp">Connect AI apps</a>
          <a href="/docs/transactional-email">API reference</a>
          <a href="/llms.txt">llms.txt</a>
        </div>
        <div>
          <span className="muted">Company</span>
          <a href="/blog">Blog</a>
          <a href="mailto:hello@xstate.com">Contact</a>
        </div>
        <div>
          <span className="muted">Legal</span>
          <a href="/docs/privacy">Privacy</a>
          <a href="/docs/terms">Terms</a>
          <a href="/docs/refunds">Refunds</a>
          <a href="/docs/security">Security overview</a>
        </div>
      </div>
      <div className="machine">
        <span style={{ color: 'var(--ink)' }}>Machine readable</span>
        <a href="/llms.txt">/llms.txt</a>
        <a href="/blog/feed.json">/blog/feed.json</a>
        <a href="/changelog.json">/changelog.json</a>
        <a href="/docs.md">/docs.md</a>
        <span className="note">Add Accept: text/markdown or application/json to any blog post</span>
      </div>
      <div className="footer-base">
        <span>© 2026 xstate</span>
      </div>
    </footer>
  )
}
