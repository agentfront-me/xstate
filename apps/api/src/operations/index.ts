// Every operation the API exposes. The HTTP router (and later the MCP server) is built from this list.

import { agentOperations } from './agents'
import { audienceOperations } from './audience'
import { authOperations } from './auth'
import { calendarOperations } from './calendar'
import { deviceOperations } from './devices'
import type { AnyOperation } from './define'
import { emailOperations } from './email'
import { memberOperations } from './members'
import { migrationOperations } from './migration'
import { storageOperations } from './storage'

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
]
