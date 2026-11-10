-- Agents, Phase 3 (docs/agents-plan.md): tool calls waiting for a person. Kept in D1, not the agent's store, so the
-- agent list can show "3 need approval" and the Approvals tab can list them without waking every agent.
-- The run itself waits on a Workflow event (agents/run.ts); deciding here sends that event.
CREATE TABLE agent_approvals (
  id               TEXT PRIMARY KEY,                -- "<run id>:<step>-<call>": one per tool call
  agent_id         TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL,
  step_key         TEXT NOT NULL,                   -- "<step>-<call>", the event the run waits for
  tool             TEXT NOT NULL,
  input            TEXT NOT NULL,                   -- JSON the agent proposed
  edited_input     TEXT,                            -- JSON the approver changed it to ("Edit and approve")
  reason           TEXT NOT NULL DEFAULT '',        -- what the agent said before the call
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  note             TEXT,                            -- the approver's note, sent back to the agent on reject
  decided_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at       TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
CREATE INDEX agent_approvals_agent ON agent_approvals (agent_id, status, created_at);
CREATE INDEX agent_approvals_org ON agent_approvals (organization_id, status);
