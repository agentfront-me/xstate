// Every operation the API exposes. The HTTP router and the MCP server (mcp/server.ts) are built from this list.

import { agentOperations } from './agents'
import { audienceOperations } from './audience'
import { authOperations } from './auth'
import { billingOperations } from './billing'
import { calendarOperations } from './calendar'
import { connectionOperations } from './connections'
import { deviceOperations } from './devices'
import type { AnyOperation } from './define'
import { emailOperations } from './email'
import { memberOperations } from './members'
import { migrationOperations } from './migration'
import { storageOperations } from './storage'
import { tokenOperations } from './tokens'
import { appPasswordOperations } from './app-passwords'

export const operations: readonly AnyOperation[] = [
  ...authOperations,
  ...emailOperations,
  ...calendarOperations,
  ...memberOperations,
  ...migrationOperations,
  ...storageOperations,
  ...audienceOperations,
  ...agentOperations,
  ...deviceOperations,
  ...connectionOperations,
  ...billingOperations,
  ...tokenOperations,
  ...appPasswordOperations,
]
