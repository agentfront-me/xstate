// 5 · Connect your agent, and the Done screen.
//
// The step only shows how to add xstate to the app. What the app may do is chosen on the consent page (/connect/),
// which the app opens when it first connects, so this step asks nothing itself. It watches for the connection to
// appear and says so, which tells the person the sign-in worked.

import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { track } from '../lib/analytics'
import { api, MCP_URL, signOut } from '../lib/core'
import { domainName, progress, setProgress, type Data } from './state'
import { Back, Head, useCopied } from './ui'

type Agent = { id: string; name: string; icon: IconName; label: string; snippet?: string; then: string }

const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude',
    icon: 'sparkles',
    label: 'In Claude, open Customize → Connectors, choose Add → Add custom connector, and paste this address.',
    snippet: MCP_URL,
    then: 'Click Connect, and approve xstate in the page that opens. On a Team or Enterprise plan, an Owner adds the connector first.',
  },
  {
    id: 'code',
    name: 'Claude Code',
    icon: 'terminal',
    label: 'Run this in your terminal',
    snippet: `claude mcp add --transport http xstate ${MCP_URL}`,
    then: 'Then run /mcp in Claude Code, pick xstate and sign in.',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: 'square-code',
    label: 'Run this in your terminal',
    snippet: `codex mcp add xstate --url ${MCP_URL}\ncodex mcp login xstate`,
    then: 'The second command opens xstate in your browser to approve it.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'mouse-pointer-2',
    label: 'Add this to ~/.cursor/mcp.json',
    snippet: `{\n  "mcpServers": {\n    "xstate": { "url": "${MCP_URL}" }\n  }\n}`,
    then: 'Then open Cursor Settings → MCP and click Connect next to xstate.',
  },
]

type Connection = { id: string; app: string; person: { you: boolean } }

/** The apps this person has connected to the organization, checked every 5 seconds while `watch` is on. */
function useConnections(orgId: string, watch: boolean): Connection[] | null {
  const [connections, setConnections] = useState<Connection[] | null>(null)
  useEffect(() => {
    let stopped = false
    const load = () =>
      api<{ connections: Connection[] }>('GET', `/orgs/${orgId}/connections`)
        .then((r) => !stopped && setConnections(r.connections.filter((c) => c.person.you)))
        .catch(() => undefined)
    void load()
    const timer = watch ? setInterval(load, 5000) : undefined
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [orgId, watch])
  return connections
}

function Snippet({ text }: { text: string }) {
  const [copied, copy] = useCopied()
  return (
    <div className="snippet">
      <pre>{text}</pre>
      <button type="button" aria-label="Copy" onClick={() => void copy(text)}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )
}

export function AgentStep({ data, back, next }: { data: Data; back: () => void; next: () => void }) {
  const [selected, setSelected] = useState(() => progress().agent?.id ?? 'claude')
  const agent = AGENTS.find((a) => a.id === selected) ?? AGENTS[0]!
  const connections = useConnections(data.org.id, true)
  const connected = connections?.length ? connections : null

  return (
    <>
      <Back onClick={back} />
      <Head title="Connect your AI agent" sub="Let the agent you already use read your mail and draft replies. You choose what it may do when you approve it. Optional." />
      <div className="agents" id="agents">
        {AGENTS.map((a) => (
          <button type="button" className="agent" key={a.id} aria-pressed={a.id === selected} onClick={() => setSelected(a.id)}>
            <span className="agent-icon">
              <Icon name={a.icon} />
            </span>
            <span className="agent-name">{a.name}</span>
            {a.id === selected && (
              <span className="check">
                <Icon name="check" size={14} />
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="panel">
        <div className="panel-section" id="setup">
          <div className="small muted">{agent.label}</div>
          {agent.snippet && <Snippet text={agent.snippet} />}
          <div className="small muted">{agent.then}</div>
        </div>
        <div className="panel-section" id="status" role="status">
          {connected ? (
            <span className="small status-line">
              <Icon name="circle-check" size={13} />
              Connected: {[...new Set(connected.map((c) => c.app))].join(', ')}
            </span>
          ) : (
            <span className="small muted status-line">
              <span className="spinner" />
              Waiting for your agent to connect…
            </span>
          )}
        </div>
      </div>
      <div className="tip">
        <Icon name="message-square" size={14} />
        <span>
          Try it. Ask your agent: <span className="hi">"Summarize my inbox"</span>
        </span>
      </div>
      <button
        className="btn btn-primary"
        id="finish"
        onClick={() => {
          if (!progress().finished) track('Onboarding Completed', { domain_verified: data.domain?.status === 'verified', agent_connected: !!connected })
          setProgress({ finished: true, agent: { id: selected } })
          next()
        }}
      >
        Continue to inbox
      </button>
      <a
        className="link"
        href="#"
        id="skip"
        onClick={(event) => {
          event.preventDefault()
          if (!progress().finished) track('Onboarding Completed', { domain_verified: data.domain?.status === 'verified', agent_connected: !!connected })
          setProgress({ finished: true })
          next()
        }}
      >
        Skip for now
      </a>
    </>
  )
}

export function DoneStep({ data, verify, agent }: { data: Data; verify: () => void; agent: () => void }) {
  const personal = data.mailboxes.find((m) => m.kind === 'personal') ?? data.mailboxes[0]
  const verified = data.domain?.status === 'verified'
  const connected = !!useConnections(data.org.id, false)?.length
  const first = (data.user.name ?? '').split(/\s+/)[0]
  const items: { label: string; done?: boolean; action?: string; go?: () => void }[] = [
    { label: 'Create your first address', done: true },
    { label: `Connect ${domainName(data)}`, done: verified, action: 'Connect', go: verify },
    { label: 'Send yourself a test email' },
    { label: 'Add a teammate', done: !!data.teammates },
    { label: 'Connect an AI agent', done: connected, action: 'Connect', go: agent },
  ]

  return (
    <>
      <Head title="Your inbox is ready" sub={`Hi${first ? ` ${first}` : ''}, your address is ${personal?.address ?? ''}.`} />
      <p className="muted">A few small things will get you fully set up:</p>
      <div className="checklist">
        {items.map((item) => (
          <div className={`check-item${item.done ? ' is-done' : ''}`} key={item.label}>
            <Icon name={item.done ? 'circle-check' : 'circle'} size={16} />
            <span>{item.label}</span>
            {item.action && !item.done && (
              <button type="button" className="mini" onClick={item.go}>
                {item.action}
              </button>
            )}
          </div>
        ))}
      </div>
      {!verified && <div className="small muted">Mail to {domainName(data)} starts arriving once its DNS records are in place.</div>}
      <a className="btn btn-primary" href="/app/">
        Open xstate
      </a>
      <a
        className="link"
        href="#"
        id="sign-out"
        onClick={(event) => {
          event.preventDefault()
          signOut()
        }}
      >
        Sign out
      </a>
    </>
  )
}
