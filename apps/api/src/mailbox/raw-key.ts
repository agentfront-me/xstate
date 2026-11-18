// Where a message's raw copy lives in the organization's bucket: inside the mailbox's folder, so it goes with the
// mailbox (storage/files.ts deleteMailboxFolder).
export const rawKey = (mailboxId: string, emailId: string) => `${mailboxId}/raw/${emailId}.eml`
