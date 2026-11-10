// What's wrong with an agent, shown as a banner on its page (design: error banner) and as a short line in the agent
// list. Each problem comes with the button that fixes it: Fix key, Sign in, Raise cap, Retry failed runs.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import { agentKeys, agentsApi, type Agent, type Issue } from './api'

/** A few words for the agent list. */
export function issueShort(issue: Issue): string {
  if (issue.kind === 'key') return 'Error · AI key'
  if (issue.kind === 'connector') return 'Error · connector'
  if (issue.kind === 'spend') return issue.blocking ? 'Paused · spend cap' : 'Over spend cap'
  return `${issue.count} failed run${issue.count === 1 ? '' : 's'}`
}

export function useHealth(agentId: string) {
  return useQuery({ queryKey: agentKeys.health(agentId), queryFn: () => agentsApi.health(agentId), refetchInterval: 60_000 })
}

export function IssueBanner({ orgId, agent, admin, onOpenSettings }: { orgId: string; agent: Agent; admin: boolean; onOpenSettings: () => void }) {
  const health = useHealth(agent.id)
  const issues = health.data?.issues ?? []
  if (!issues.length) return null
  return (
    <div className="a-banners">
      {issues.map((issue) => (
        <Banner key={issue.kind + ('connectorId' in issue ? issue.connectorId : '')} orgId={orgId} agent={agent} admin={admin} issue={issue} onOpenSettings={onOpenSettings} />
      ))}
    </div>
  )
}

function Banner({ orgId, agent, admin, issue, onOpenSettings }: { orgId: string; agent: Agent; admin: boolean; issue: Issue; onOpenSettings: () => void }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const warn = issue.kind === 'failures' || (issue.kind === 'spend' && !issue.blocking)

  const retry = async () => {
    setBusy(true)
    try {
      const r = await agentsApi.retryFailed(agent.id)
      toast(
        r.started
          ? `Retrying ${r.started} run${r.started === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} skipped: ${r.reason}` : ''}`
          : r.skipped
            ? `Not retried: ${r.reason}`
            : 'Nothing left to retry',
      )
      await Promise.all([
        client.invalidateQueries({ queryKey: agentKeys.health(agent.id) }),
        client.invalidateQueries({ queryKey: agentKeys.runs(agent.id) }),
        client.invalidateQueries({ queryKey: agentKeys.stats(agent.id) }),
        client.invalidateQueries({ queryKey: agentKeys.list(orgId) }),
      ])
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const action =
    issue.action === 'fix_key' ? (
      <button className="btn" disabled={!admin} title={admin ? undefined : 'Ask an owner or admin'} onClick={() => void navigate({ to: '/settings/$section', params: { section: 'ai-providers' } })}>
        Fix key
      </button>
    ) : issue.action === 'sign_in' ? (
      <button className="btn" onClick={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })}>Sign in</button>
    ) : issue.action === 'raise_cap' ? (
      <button className="btn" onClick={onOpenSettings}>Raise cap</button>
    ) : (
      <button className="btn" disabled={busy || !agent.publishedVersion} onClick={() => void retry()}>
        {busy ? <span className="spinner" /> : <Icon name="rotate-ccw" size={13} />}Retry failed runs
      </button>
    )

  return (
    <div className={`a-banner${warn ? ' warn' : ''}`} role="status">
      <Icon name={warn ? 'circle-alert' : 'circle-x'} size={15} />
      <span className="a-banner-text">{issue.message}</span>
      {action}
    </div>
  )
}
