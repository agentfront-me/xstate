// Every operation the API exposes. The HTTP router (and later the MCP server) is built from this list.

import { audienceOperations } from './audience'
import { authOperations } from './auth'
import type { AnyOperation } from './define'
import { emailOperations } from './email'
import { storageOperations } from './storage'

export const operations: readonly AnyOperation[] = [
  ...authOperations,
  ...emailOperations,
  ...storageOperations,
  ...audienceOperations,
]
