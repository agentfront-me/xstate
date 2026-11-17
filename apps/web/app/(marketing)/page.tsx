import type { Metadata } from 'next'
import { posts, releases } from '@/lib/blog'
import { SIGNUP_URL } from '@/lib/urls'
import { Cta, SiteFooter, SiteHeader } from './chrome'
import { Pricing } from './controls'
import { PostList } from './post-list'

export const metadata: Metadata = {
  title: { absolute: 'xstate · Free business email with AI agents, on your own domain' },
  alternates: {
    types: {
      'text/plain': '/llms.txt',
      'application/feed+json': '/blog/feed.json',
      'application/rss+xml': '/blog/rss.xml',
    },
  },
}

const faqs = [
  ['Do I need to own a domain?', 'Yes, for now. Connect a domain you own. Buying one during setup and a free xstate subdomain are coming.'],
  ['Which agents can read my mail?', 'Claude, Claude Code, Codex, Cursor and ChatGPT connect over MCP. You approve each one and choose its mailboxes and what it may do: read, draft or send mail, and read or change your calendar, files and contacts.'],
  ['How is this different from Google Workspace?', 'xstate is built for working with AI. Each AI app you connect gets its own access, limited to the mailboxes you pick and the actions you tick. Search by meaning across mail, attachments and files is included, and the free plan covers up to 5 people.'],
  ['Can I move from Gmail or Google Workspace?', 'Yes. An administrator authorizes the import once, and xstate copies your mail, calendars, contacts and Drive files, then keeps the copy up to date until you switch your domain over.'],
  ['Do you use my mail to train AI?', 'No. We do not use your content to train AI models, for advertising or for profiling, and our staff do not read it unless you ask us to. Agents use the AI provider and key your organization chooses.'],
  ['How long does DNS take?', 'Usually a few minutes. xstate checks every few seconds and ticks off each record as it appears.'],
  ['Can I take my data with me?', 'Yes. Your mail stays reachable over IMAP, so any mail app can copy it out, and files in Storage download as they are. Contacts export as CSV.'],
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
      description: 'Business email, calendar and files on your own domain, with AI agents you control.',
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
  { id: 'F01', tag: 'email', title: 'Email and calendar on your domain', body: 'Addresses on a domain you own, with aliases, shared inboxes and a calendar for every mailbox.', points: ['hello@, support@, sales@ in one click', 'Invitations and replies from the same account', 'IMAP, SMTP and JMAP'] },
  { id: 'F02', tag: 'dns', title: 'DNS that checks itself', body: 'xstate shows the records your domain needs and checks public DNS every few seconds until they are in place.', points: ['Live status for each record', 'Copy them all as a zone file', 'Send the records to a developer'] },
  { id: 'F03', tag: 'agents', title: 'Nothing goes out without your permission', body: 'Connect an agent over MCP. Each gets its own token and only the permissions you tick.', points: ['Read, draft or send: you tick which', 'Only the mailboxes you pick', 'Disconnect in one click'] },
  { id: 'F04', tag: 'search', title: 'Search across mail and files', body: 'Ask a question and get the passages that answer it, from your mail, attachments and files.', points: ['Search by meaning, in any language', 'PDFs and attachments included', 'Agents search the same index'] },
  { id: 'F05', tag: 'files', title: 'Storage for every mailbox', body: 'Save attachments, share files with your team and keep earlier versions.', points: ['Save attachments in one click', 'Personal and shared spaces', 'AI apps get no access, read, or read and change'] },
  { id: 'F06', tag: 'import', title: 'Move from Google Workspace', body: 'Bring your mail, calendars, contacts and Drive files across in one import, kept in sync until you switch.', points: ['One authorization for the whole domain', 'Mail, calendars, contacts and Drive', 'Switch your domain when the copy is done'] },
]

export default function Home() {
  const latest = releases[0]
  return (
    <div className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <SiteHeader />

      <section className="grid hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <div className="small muted mono">001 · Business email for teams that work with AI</div>
          <h1 id="hero-h">Business email your AI can work in, on your own domain.</h1>
          <p className="muted">
            Email, calendar and files for your team, free for up to 5 people. Connect Claude, Codex or Cursor and choose exactly what each one may read, draft or send.
          </p>
          <div className="row">
            <a href={SIGNUP_URL} className="btn btn-solid">
              Start free
            </a>
            <a href="/docs/quickstart" className="btn">
              Read the quickstart
            </a>
          </div>
          <div className="small faint mono">Bring a domain you own · Set up in minutes</div>
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
            Something else? Email <a href="mailto:hello@xstate.com">hello@xstate.com</a>.
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

/** Claude connects to xstate, which holds the domain's email, calendar, files and agents, and talks to the world. */
function HeroArt() {
  return (
    <svg
      viewBox="0 0 560 360"
      role="img"
      aria-label="Claude connects to xstate, which holds your domain's email, calendar, files and agents, and talks to your customers, team and visitors."
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
        <Box x={308} y={86} w={90} h={32} label="Files" begin="1.9s" />
        <Box x={162} y={242} w={90} h={32} label="Calendar" begin="2.1s" />
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
        Your agent works inside your domain. Nothing goes out without your permission.
        <Fade begin="3.2s" dur="0.6s" />
      </text>
    </svg>
  )
}
