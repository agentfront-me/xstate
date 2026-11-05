// Every operation the API exposes. The HTTP router (and later the MCP server) is built from this list.

import { authOperations } from './auth'
import type { AnyOperation } from './define'
import { emailOperations } from './email'

export const operations: readonly AnyOperation[] = [...authOperations, ...emailOperations]
