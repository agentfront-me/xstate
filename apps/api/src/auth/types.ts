/** The signed-in user performing an operation, taken from their JWT. */
export type Actor = { userId: string }

export type User = { id: string; email: string; name: string | null; createdAt: string }
