import type { Metadata } from 'next'
import { LOGIN_URL, SIGNUP_URL } from '@/lib/urls'
import { Pricing, ThemeToggle } from './controls'

export const metadata: Metadata = {
  title: { absolute: 'xstate · Your Digital Real Estate' },
  alternates: {
    types: {
      'application/json': '/index.json',
      'text/plain': '/llms.txt',
      'application/feed+json': '/blog/feed.json',
    },
  },
}

const faqs = [
  ['Do I need to own a domain?', 'No. Connect one you own, buy one during setup, or start on a free you.xstate.email subdomain and move later.'],
  ['Which agents can read my mail?', 'Claude, Claude Code, Codex and Cursor connect over MCP. Each agent gets its own scoped token; you choose read, draft, send and label permissions.'],
  ['How long does DNS take?', 'With Domain Connect (Cloudflare, GoDaddy, IONOS) records are written for you and verify in under a minute. Manual records usually verify within 15 minutes.'],
  ['Can I export everything?', 'Yes. Mail as .mbox, data as JSON or CSV, sites as static files. Exports are available on every plan.'],
  ['What does machine readable mean here?', 'Every public URL returns HTML by default and JSON or Markdown when asked via the Accept header. The site also publishes llms.txt, an OpenAPI document, an MCP manifest and schema.org data in each page.'],
]

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', name: 'xstate', url: 'https://xstate.com', logo: 'https://xstate.com/brand/icon-512-dark.png' },
    {
      '@type': 'SoftwareApplication',
      name: 'xstate',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description: 'Your domain, emails, data, agents and sites in one place.',
      offers: [
        { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
        { '@type': 'Offer', name: 'Pro', price: '8', priceCurrency: 'USD' },
        { '@type': 'Offer', name: 'Team', price: '24', priceCurrency: 'USD' },
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: faqs.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })),
    },
  ],
}

const features = [
  { id: 'F01', tag: 'email', title: 'Email on your domain', body: 'Addresses on a domain you own, with sending, receiving, aliases and catch-all.', points: ['hello@, support@, sales@ in one click', 'IMAP, SMTP and JMAP', 'Shared inboxes per address'] },
  { id: 'F02', tag: 'dns', title: 'DNS that verifies itself', body: 'Records are written through Domain Connect where supported and checked automatically.', points: ['Cloudflare, GoDaddy, IONOS', 'Manual copy with live status', 'Send records to a developer'] },
  { id: 'F03', tag: 'agents', title: 'Agents with scoped access', body: 'Connect an agent over MCP. Each gets its own token and only the permissions you tick.', points: ['Read, draft, send, label', 'Per-agent audit log', 'Revoke in one click'] },
  { id: 'F04', tag: 'data', title: 'Data you can query', body: 'Mail, contacts and files are indexed into tables you and your agents can read.', points: ['SQL and JSON endpoints', 'Full-text search', 'Daily snapshots'] },
  { id: 'F05', tag: 'sites', title: 'Sites on the same domain', body: 'Publish static pages and forms at your root or any subdomain, no extra host.', points: ['Deploy from git or upload', 'Forms land in your inbox', 'Edge cache, free TLS'] },
  { id: 'F06', tag: 'api', title: 'Human and machine readable', body: 'Every public page serves HTML to people and JSON, Markdown or llms.txt to programs.', points: ['Content negotiation on every URL', 'OpenAPI and MCP manifests', 'Structured data on every page'] },
]

const quotes = [
  { text: 'We moved three domains off a legacy host on a Friday afternoon. DNS verified before the coffee was ready.', who: 'Mara Ilic · Founder', site: 'ilic.studio' },
  { text: 'Giving Claude read and draft on support@ but not send was exactly the control I wanted. The audit log sealed it.', who: 'Devon Park · Head of Ops', site: 'parkandco.io' },
  { text: 'The JSON endpoints mean our agents and our dashboards read the same data. One source, no sync jobs.', who: 'Ines Okafor · Engineer', site: 'okafor.dev' },
]

const posts = [
  { slug: 'content-negotiation', date: '2026-10-28', title: 'Why every page on xstate answers to Accept: application/json', summary: 'Content negotiation as the default, and what it took to get Markdown right.', read: '6 min' },
  { slug: 'agent-permissions', date: '2026-10-14', title: 'Scoped tokens for agents: read, draft, send, label', summary: 'How the permission model works and why send is off by default.', read: '4 min' },
  { slug: 'domain-connect', date: '2026-09-30', title: 'Domain Connect in practice', summary: 'What verifies in 48 seconds, what takes 15 minutes, and what to do about the rest.', read: '5 min' },
  { slug: 'changelog-september', date: '2026-09-16', title: 'Changelog: catch-all, JMAP, MCP manifest', summary: 'Three releases in September.', read: '2 min' },
]

export default function Home() {
  return (
    <div className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <header className="site-header">
        <a href="/">xstate</a>
        <nav aria-label="Primary">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#blog">Blog</a>
          <a href="#faq">FAQ</a>
          <a href="/docs">Docs</a>
        </nav>
        <div className="header-actions">
          <ThemeToggle />
          <a href={LOGIN_URL} className="quiet">
            Log in
          </a>
          <a href={SIGNUP_URL} className="btn btn-solid">
            Get started
          </a>
        </div>
      </header>

      <section className="grid hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <div className="small muted mono">001 · Your Digital Real Estate</div>
          <h1 id="hero-h">Your domain, emails, data, agents and sites in one place.</h1>
          <p className="muted">
            Point a domain at xstate and get a working inbox in under a minute. Connect Claude, Codex or Cursor to it with scoped permissions. Everything you own stays on a domain you control.
          </p>
          <div className="row">
            <a href={SIGNUP_URL} className="btn btn-solid">
              Connect a domain
            </a>
            <a href="/docs/quickstart" className="btn">
              Read the quickstart
            </a>
          </div>
          <div className="small faint mono">curl -s https://xstate.com/llms.txt</div>
        </div>
        <div className="hero-art">
          <HeroArt />
        </div>
      </section>

      <section id="features" className="section" aria-labelledby="feat-h">
        <div className="section-head">
          <h2 id="feat-h">Features</h2>
          <span className="small muted mono">6 modules · 1 account</span>
        </div>
        <div className="grid">
          {features.map((f) => (
            <article className="card" key={f.id}>
              <div className="card-meta small mono muted">
                <span>{f.id}</span>
                <span>{f.tag}</span>
              </div>
              <h3>{f.title}</h3>
              <p className="small muted">{f.body}</p>
              <ul>
                {f.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="quotes-h">
        <div className="section-head">
          <h2 id="quotes-h">From people who moved</h2>
          <span className="small muted mono">3 of 212 reviews</span>
        </div>
        <div className="grid">
          {quotes.map((q) => (
            <blockquote className="quote" key={q.site}>
              <p>{q.text}</p>
              <footer className="small muted">
                <span>{q.who}</span>
                <span className="mono">{q.site}</span>
              </footer>
            </blockquote>
          ))}
        </div>
      </section>

      <Pricing />

      <section id="blog" className="section" aria-labelledby="blog-h">
        <div className="section-head">
          <h2 id="blog-h">Blog</h2>
          <a href="/blog/feed.json" className="small muted mono">
            feed.json ↗
          </a>
        </div>
        <div className="posts">
          {posts.map((p) => (
            <a className="post" href={`/blog/${p.slug}`} key={p.slug}>
              <time dateTime={p.date} className="small muted mono">
                {p.date}
              </time>
              <span className="post-body">
                <span>{p.title}</span>
                <span className="small muted">{p.summary}</span>
              </span>
              <span className="read small faint mono">{p.read}</span>
            </a>
          ))}
        </div>
      </section>

      <section id="faq" className="faq" aria-labelledby="faq-h">
        <div className="faq-intro">
          <h2 id="faq-h">Questions</h2>
          <p className="small muted">
            Also answered at{' '}
            <a href="/faq.json" className="mono">
              /faq.json
            </a>{' '}
            and in the page&apos;s structured data.
          </p>
        </div>
        <div className="faq-list">
          {faqs.map(([q, a]) => (
            <details key={q}>
              <summary>
                <span>{q}</span>
                <span className="faint mono">
                  <span className="fq-plus">+</span>
                  <span className="fq-minus">−</span>
                </span>
              </summary>
              <p className="small muted">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta" aria-labelledby="cta-h">
        <div className="cta-copy">
          <h2 id="cta-h">Connect a domain. Inbox in under a minute.</h2>
          <p className="small muted">No card on the free plan. Export everything, any time.</p>
        </div>
        <div className="row">
          <a href={SIGNUP_URL} className="btn btn-solid">
            Get started
          </a>
          <a href="/docs/api" className="btn">
            API reference
          </a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-cols">
          <div>
            <span style={{ fontSize: 14 }}>xstate</span>
            <span className="muted">Your Digital Real Estate</span>
          </div>
          <div>
            <span className="muted">Product</span>
            <a href="/email">Email</a>
            <a href="/agents">Agents</a>
            <a href="/data">Data</a>
            <a href="/sites">Sites</a>
          </div>
          <div>
            <span className="muted">Developers</span>
            <a href="/docs">Docs</a>
            <a href="/docs/api">API reference</a>
            <a href="/docs/mcp">MCP</a>
            <a href="/status">Status</a>
          </div>
          <div>
            <span className="muted">Company</span>
            <a href="/blog">Blog</a>
            <a href="#pricing">Pricing</a>
            <a href="/changelog">Changelog</a>
            <a href="mailto:hello@xstate.com">Contact</a>
          </div>
          <div>
            <span className="muted">Legal</span>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/dpa">DPA</a>
            <a href="/security">Security</a>
          </div>
        </div>
        <div className="machine">
          <span style={{ color: 'var(--ink)' }}>Machine readable</span>
          <a href="/llms.txt">/llms.txt</a>
          <a href="/index.json">/index.json</a>
          <a href="/openapi.json">/openapi.json</a>
          <a href="/sitemap.xml">/sitemap.xml</a>
          <a href="/.well-known/mcp.json">/.well-known/mcp.json</a>
          <span className="note">Add Accept: application/json to any public URL</span>
        </div>
        <div className="footer-base">
          <span>© 2026 xstate</span>
          <span className="mono">status: all systems normal · 99.98% 90d</span>
        </div>
      </footer>
    </div>
  )
}

const MONO = 'ui-monospace, Menlo, monospace'

function Fade({ begin, dur = '0.4s' }: { begin: string; dur?: string }) {
  return <animate attributeName="opacity" to="1" dur={dur} begin={begin} fill="freeze" />
}

function Dot({ path, begin, dur, muted }: { path: string; begin: string; dur: string; muted?: boolean }) {
  return (
    <circle r="3.5" opacity="0" fill={muted ? 'var(--muted)' : undefined}>
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur={dur} begin={begin} repeatCount="indefinite" />
      <animateMotion path={path} dur={dur} begin={begin} repeatCount="indefinite" />
    </circle>
  )
}

function Box({ x, y, w, h, label, begin }: { x: number; y: number; w: number; h: number; label: string; begin?: string }) {
  return (
    <g opacity={begin ? 0 : undefined}>
      {begin && <Fade begin={begin} />}
      <rect x={x} y={y} width={w} height={h} rx="8" fill="var(--surface)" stroke="var(--faint)" />
      <text x={x + w / 2} y={y + h / 2 + 4}>
        {label}
      </text>
    </g>
  )
}

/** Claude connects to xstate, which holds the domain's email, data, sites and agents, and talks to the world. */
function HeroArt() {
  return (
    <svg
      viewBox="0 0 560 360"
      role="img"
      aria-label="Claude connects to xstate, which holds your domain, email, data, sites and agents, and talks to your customers, team and visitors."
      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
      fontSize="12"
    >
      <rect x="140" y="40" width="280" height="280" rx="20" fill="none" stroke="var(--faint)" pathLength={1} strokeDasharray="1" strokeDashoffset="1">
        <animate attributeName="stroke-dashoffset" from="1" to="0" dur="1.2s" begin="0.05s" fill="freeze" />
      </rect>
      <text x="280" y="64" textAnchor="middle" fill="var(--muted)" fontFamily={MONO} fontSize="11" opacity="0">
        yourcompany.com
        <Fade begin="1.1s" dur="0.5s" />
      </text>
      <g opacity="0">
        <Fade begin="1.3s" dur="0.5s" />
        <circle cx="280" cy="180" r="30" fill="none" stroke="var(--faint)">
          <animate attributeName="r" values="30;80" dur="3s" begin="2.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0" dur="3s" begin="2.5s" repeatCount="indefinite" />
        </circle>
        <rect x="236" y="162" width="88" height="36" rx="8" fill="var(--ink)" />
        <text x="280" y="185" textAnchor="middle" fill="var(--paper)" fontSize="13">
          xstate
        </text>
      </g>
      <g fill="var(--ink)" textAnchor="middle">
        <Box x={162} y={86} w={90} h={32} label="Email" begin="1.7s" />
        <Box x={308} y={86} w={90} h={32} label="Data" begin="1.9s" />
        <Box x={162} y={242} w={90} h={32} label="Sites" begin="2.1s" />
        <Box x={308} y={242} w={90} h={32} label="Agents" begin="2.3s" />
        <g fill="none" stroke="var(--faint)" opacity="0">
          <Fade begin="2.4s" />
          <line x1="236" y1="118" x2="256" y2="162" />
          <line x1="324" y1="118" x2="304" y2="162" />
          <line x1="236" y1="242" x2="256" y2="198" />
          <line x1="324" y1="242" x2="304" y2="198" />
        </g>
      </g>
      <g opacity="0" fill="var(--ink)" textAnchor="middle">
        <Fade begin="2.6s" dur="0.5s" />
        <text x="60" y="150" fill="var(--faint)" fontSize="11">
          Your agent
        </text>
        <Box x={10} y={162} w={100} h={36} label="Claude / Codex" />
      </g>
      <g opacity="0" fill="var(--ink)" textAnchor="middle">
        <Fade begin="2.6s" dur="0.5s" />
        <text x="500" y="98" fill="var(--faint)" fontSize="11">
          The internet
        </text>
        <Box x={456} y={110} w={88} h={32} label="Customers" />
        <Box x={456} y={164} w={88} h={32} label="Your team" />
        <Box x={456} y={218} w={88} h={32} label="Visitors" />
      </g>
      <g fill="none" stroke="var(--faint)" opacity="0">
        <Fade begin="2.8s" dur="0.5s" />
        <path d="M110,180 L 140,180" />
        <path d="M420,180 C 436,180 440,126 456,126" />
        <path d="M420,180 L 456,180" />
        <path d="M420,180 C 436,180 440,234 456,234" />
      </g>
      <g fill="var(--ink)">
        <Dot path="M110,180 L 236,180" dur="2s" begin="3s" />
        <Dot path="M236,180 L 110,180" dur="2s" begin="5s" />
        <Dot path="M456,126 C 440,126 436,180 420,180 L 324,180" dur="2.2s" begin="3.4s" muted />
        <Dot path="M324,180 L 420,180 L 456,180" dur="2.2s" begin="4.4s" muted />
        <Dot path="M324,180 L 420,180 C 436,180 440,234 456,234" dur="2.2s" begin="5.4s" muted />
      </g>
      <text x="280" y="348" textAnchor="middle" fill="var(--muted)" fontSize="11" opacity="0">
        Your agent works inside your domain. Nothing leaves without you.
        <Fade begin="3.2s" dur="0.6s" />
      </text>
    </svg>
  )
}
