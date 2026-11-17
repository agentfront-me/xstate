import type { Metadata } from 'next'
import { posts, releases } from '@/lib/blog'
import { SIGNUP_URL } from '@/lib/urls'
import { Cta, SiteFooter, SiteHeader } from './chrome'
import { Pricing } from './controls'
import { PostList } from './post-list'

export const metadata: Metadata = {
  title: { absolute: 'xstate · Your Digital Real Estate' },
  alternates: {
    types: {
      'text/plain': '/llms.txt',
      'application/feed+json': '/blog/feed.json',
      'application/rss+xml': '/blog/rss.xml',
    },
  },
}

const faqs = [
  ['Do I need to own a domain?', 'No. Connect one you own, buy one during setup, or start on a free you.xstate.email subdomain and move later.'],
  ['Which agents can read my mail?', 'Claude, Claude Code, Codex, Cursor and ChatGPT connect over MCP. You approve each one and choose its mailboxes and what it may do: read, draft or send mail, and read or change your calendar, files and contacts.'],
  ['How long does DNS take?', 'Usually a few minutes after you add the records, though some DNS providers take longer to publish changes. xstate checks every few seconds and shows each record as it appears, so you can leave the page open. One-click setup through Domain Connect is rolling out, starting with Cloudflare.'],
  ['Can I export everything?', 'Yes. Mail as .mbox, data as JSON or CSV, sites as static files. Exports are available on every plan.'],
  ['What does machine readable mean here?', 'Pages are written for people and published for programs too. Every docs page has a Markdown version (add .md to its URL), blog posts and the changelog return Markdown or JSON when asked via the Accept header, and /llms.txt lists all of it for agents. Pages also carry schema.org data.'],
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
        { '@type': 'Offer', name: 'Pro', price: '6', priceCurrency: 'USD' },
        { '@type': 'Offer', name: 'Team', price: '12', priceCurrency: 'USD' },
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
  { id: 'F02', tag: 'dns', title: 'DNS that checks itself', body: 'xstate shows the records your domain needs and checks public DNS every few seconds until they are in place.', points: ['Live status for each record', 'Copy them all as a zone file', 'Send the records to a developer'] },
  { id: 'F03', tag: 'agents', title: 'Agents with scoped access', body: 'Connect an agent over MCP. Each gets its own token and only the permissions you tick.', points: ['Read, draft or send', 'Only the mailboxes you pick', 'Disconnect in one click'] },
  { id: 'F04', tag: 'data', title: 'Data you can query', body: 'Mail, contacts and files are indexed into tables you and your agents can read.', points: ['SQL and JSON endpoints', 'Full-text search', 'Daily snapshots'] },
  { id: 'F05', tag: 'sites', title: 'Sites on the same domain', body: 'Publish static pages and forms at your root or any subdomain, no extra host.', points: ['Deploy from git or upload', 'Forms land in your inbox', 'Edge cache, free TLS'] },
  { id: 'F06', tag: 'api', title: 'Human and machine readable', body: 'Pages are HTML for people, with Markdown and JSON versions for agents and scripts.', points: ['Markdown for every docs page', 'llms.txt index for agents', 'JSON and RSS feeds for the blog'] },
]

export default function Home() {
  const latest = releases[0]
  return (
    <div className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <SiteHeader />

      <section className="grid hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <div className="small muted mono">001 · Your Digital Real Estate</div>
          <h1 id="hero-h">Your domain, emails, data, agents and sites in one place.</h1>
          <p className="muted">
            Point a domain at xstate and get a working inbox in minutes. Connect Claude, Codex or Cursor to it with scoped permissions. Everything you own stays on a domain you control.
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

      <Pricing />

      <section id="blog" className="section" aria-labelledby="blog-h">
        <div className="section-head">
          <h2 id="blog-h">
            <a href="/blog">Blog</a>
          </h2>
          <span className="feeds small muted mono">
            <a href="/blog/feed.json">feed.json</a>
            <a href="/blog/rss.xml">rss</a>
          </span>
        </div>
        <PostList posts={posts.slice(0, 3)} />
        <div className="section-foot small mono">
          {latest ? (
            <a href={latest.url} className="muted">
              Latest release · {latest.date} · {latest.title}
            </a>
          ) : (
            <span />
          )}
          <a href="/blog">All posts →</a>
        </div>
      </section>

      <section id="faq" className="faq" aria-labelledby="faq-h">
        <div className="faq-intro">
          <h2 id="faq-h">Questions</h2>
          <p className="small muted">
            Also in the page&apos;s structured data, for search engines and agents.
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

      <Cta />
      <SiteFooter />
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
