// Setup → Tools → Connectors: which of each connector's tools the agent may use, and when a call needs approval
// (always, never, or when a field of the call matches, like "amount is more than 100"). Read-only tools never ask.
// Changes go to the agent's draft.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { ConnectorDialog, STATUS } from '../settings/Connectors'
import { CONDITION_OPS, connectorKeys, connectorsApi, type AgentConfig, type Condition, type Connector, type ConnectorTool } from './api'

type Mode = 'always' | 'never' | 'when'

export function ConnectorTools({
  orgId,
  admin,
  config: raw,
  update,
}: {
  orgId: string
  admin: boolean
  config: AgentConfig
  update: (c: AgentConfig, delay?: number) => void
}) {
  // A config saved before connectors existed has no connectors or conditions yet.
  const config: AgentConfig = { ...raw, tools: { ...raw.tools, connectors: raw.tools.connectors ?? {}, conditions: raw.tools.conditions ?? {}, approval: raw.tools.approval ?? {} } }
  const client = useQueryClient()
  const navigate = useNavigate()
  const query = useQuery({ queryKey: connectorKeys.list(orgId), queryFn: () => connectorsApi.list(orgId) })
  const [adding, setAdding] = useState(false)
  const connectors = query.data?.connectors ?? []

  const setTools = (c: Connector, names: string[]) => update({ ...config, tools: { ...config.tools, connectors: { ...config.tools.connectors, [c.id]: names } } }, 0)

  return (
    <>
      {connectors.map((c) => {
        const enabled = config.tools.connectors[c.id] ?? []
        return (
          <div key={c.id} className="card a-conn-card">
            <div className="card-row a-group-row">
              <span className="s-tile"><Icon name="plug" size={14} /></span>
              <div className="text">
                <span className="name">
                  {c.name} <span className={`a-conn-status ${c.status}`}>{STATUS[c.status]}</span>
                </span>
                <span className="sub ellipsis">
                  {enabled.length} of {c.tools.length} tools · {c.url}
                </span>
                {c.status !== 'connected' && c.statusDetail && <span className="sub a-conn-detail">{c.statusDetail}</span>}
              </div>
              <button className="a-link" onClick={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })}>Manage</button>
            </div>
            {c.tools.map((t) => (
              <ToolRow
                key={t.name}
                connector={c}
                tool={t}
                on={enabled.includes(t.name)}
                config={config}
                onToggle={(on) => setTools(c, on ? [...enabled, t.name] : enabled.filter((n) => n !== t.name))}
                update={update}
              />
            ))}
          </div>
        )
      })}
      <div className="card a-note">
        <Icon name="plug" size={15} />
        <span>
          {connectors.length ? 'Add more' : 'Connect'} services your agent can use, like a shop, CRM or ticket system, with any MCP server.{' '}
          {admin ? (
            <button className="a-link" onClick={() => setAdding(true)}>Add connector</button>
          ) : (
            'Ask an owner or admin to add one.'
          )}
        </span>
      </div>
      {adding && (
        <ConnectorDialog orgId={orgId} onClose={() => setAdding(false)} onSaved={() => void client.invalidateQueries({ queryKey: connectorKeys.list(orgId) })} />
      )}
    </>
  )
}

function ToolRow({
  connector,
  tool,
  on,
  config,
  onToggle,
  update,
}: {
  connector: Connector
  tool: ConnectorTool
  on: boolean
  config: AgentConfig
  onToggle: (on: boolean) => void
  update: (c: AgentConfig, delay?: number) => void
}) {
  const key = `${connector.id}/${tool.name}`
  const mode: Mode = tool.readOnly ? 'never' : (config.tools.approval[key] ?? 'always')
  const condition = config.tools.conditions[key]
  const fields = Object.keys((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {})

  const setMode = (m: Mode) => {
    const conditions = { ...config.tools.conditions }
    if (m === 'when' && !conditions[key]) conditions[key] = { field: fields[0] ?? 'amount', op: 'gt', value: 100 }
    update({ ...config, tools: { ...config.tools, approval: { ...config.tools.approval, [key]: m }, conditions } }, 0)
  }
  const setCondition = (patch: Partial<Condition>, delay?: number) =>
    update(
      { ...config, tools: { ...config.tools, conditions: { ...config.tools.conditions, [key]: { ...(condition ?? { field: fields[0] ?? 'amount', op: 'gt', value: 100 }), ...patch } } } },
      delay,
    )

  return (
    <div className="card-row a-tool-row a-conn-tool-row">
      <div className="text">
        <span className="name">
          {tool.title ?? tool.name} <span className="dim small">· {tool.readOnly ? 'read only' : 'changes things'}</span>
        </span>
        <span className="sub ellipsis" title={tool.description}>{tool.description}</span>
        {on && !tool.readOnly && mode === 'when' && (
          <span className="a-rule">
            Needs approval when
            <select className="select sm" value={condition?.field ?? ''} onChange={(e) => setCondition({ field: e.target.value }, 0)}>
              {[...new Set([...(condition ? [condition.field] : []), ...fields])].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select className="select sm" value={condition?.op ?? 'gt'} onChange={(e) => setCondition({ op: e.target.value as Condition['op'] }, 0)}>
              {CONDITION_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            <input
              className="text-input a-rule-value"
              aria-label="Value"
              defaultValue={String(condition?.value ?? 100)}
              onChange={(e) => {
                const v = e.target.value
                setCondition({ value: v !== '' && Number.isFinite(Number(v)) ? Number(v) : v })
              }}
            />
          </span>
        )}
      </div>
      {!tool.readOnly && (
        <select className="select sm a-mode" value={mode} disabled={!on} aria-label="When this tool needs approval" onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="always">Always ask</option>
          <option value="when">Ask when…</option>
          <option value="never">Never ask</option>
        </select>
      )}
      <button className="switch" role="switch" aria-checked={on} aria-label={`${on ? 'Turn off' : 'Turn on'} ${tool.name}`} onClick={() => onToggle(!on)} />
    </div>
  )
}
