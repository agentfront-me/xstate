/**
 * The signed-in user performing an operation, taken from their JWT.
 *
 * `mailboxIds` is set when they act through a connection that was given only some mailboxes (a connected app over
 * MCP): mail, calendars and attachments of any other mailbox are then out of reach, whatever the user could open
 * themselves. Enforced where mail access is decided (mailserver/access.ts), so every operation obeys it.
 */
export type Actor = { userId: string; mailboxIds?: readonly string[] }

export type User = { id: string; email: string; name: string | null; createdAt: string }
