// 5 · Connect your agent, and the Done screen.

import { useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { signOut } from '../lib/core'
import { domainName, MCP_URL, progress, setProgress, type Data } from './state'
import { Back, Head, useCopied } from './ui'

type Agent = { id: string; name: string; icon: IconName; label: string; snippet?: string }

const AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude', icon: 'sparkles', label: 'Add xstate to Claude. You approve it once in Claude, then it shows up as a connector.' },
  { id: 'code', name: 'Claude Code', icon: 'terminal', label: 'Run this in your terminal', snippet: `claude mcp add --transport sse xstate ${MCP_URL}` },
  { id: 'codex', name: 'Codex', icon: 'square-code', label: 'Run this in your terminal', snippet: `codex mcp add xstate --url ${MCP_URL}` },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'mouse-pointer-2',
    label: 'Add this to .cursor/mcp.json',
    snippet: `{\n  "mcpServers": {\n    "xstate": { "url": "${MCP_URL}" }\n  }\n}`,
  },
]

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
  const personal = data.mailboxes.find((m) => m.kind === 'personal')
  const [addresses, setAddresses] = useState<string[]>(() => (personal ? [personal.address] : []))
  const [access, setAccess] = useState('draft')
  const agent = AGENTS.find((a) => a.id === selected) ?? AGENTS[0]!

  return (
    <>
      <Back onClick={back} />
      <Head title="Connect your AI agent" sub="Let the agent you already use read and draft email for you. Optional." />
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
          {agent.snippet ? (
            <Snippet text={agent.snippet} />
          ) : (
            <a className="btn btn-primary" href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">
              <Icon name="plug" size={14} />
              Add connector
            </a>
          )}
        </div>
        <fieldset className="panel-section">
          <legend>Addresses the agent can access</legend>
          {data.mailboxes.map((m) => (
            <label className="option" key={m.id}>
              <input
                type="checkbox"
                name="address"
                value={m.address}
                checked={addresses.includes(m.address)}
                onChange={(event) =>
                  setAddresses(event.target.checked ? [...addresses, m.address] : addresses.filter((a) => a !== m.address))
                }
              />
              <span className="box">
                <Icon name="check" size={12} />
              </span>
              {m.address}
            </label>
          ))}
        </fieldset>
        <fieldset className="panel-section">
          <legend>Access level</legend>
          <label className="option">
            <input type="radio" name="access" value="draft" checked={access === 'draft'} onChange={() => setAccess('draft')} />
            <span className="radio" />
            <span>
              Draft only<small>You approve before anything is sent.</small>
            </span>
          </label>
          <label className="option">
            <input type="radio" name="access" value="send" checked={access === 'send'} onChange={() => setAccess('send')} />
            <span className="radio" />
            <span>
              Draft and send<small>The agent can reply on its own.</small>
            </span>
          </label>
        </fieldset>
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
          setProgress({ finished: true, agent: { id: selected, addresses, access } })
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
  const chosen = progress().agent
  const first = (data.user.name ?? '').split(/\s+/)[0]
  const items: { label: string; done?: boolean; action?: string; go?: () => void }[] = [
    { label: 'Create your first address', done: true },
    { label: `Connect ${domainName(data)}`, done: verified, action: 'Connect', go: verify },
    { label: 'Send yourself a test email' },
    { label: 'Add a teammate' },
    { label: 'Connect an AI agent', done: !!chosen, action: 'Connect', go: agent },
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
