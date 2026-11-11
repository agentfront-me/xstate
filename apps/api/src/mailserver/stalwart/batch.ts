// Splitting per-account JMAP calls across requests. The mail server refuses a request with more method calls
// than its maxCallsInRequest (Stalwart's maxMethodCalls, 16 by default), so a view that asks the same thing of
// every mailbox (All inboxes, folder counts, the new-mail check) has to go in batches once there are many mailboxes.

type JmapArgs = Record<string, unknown>
export type Call = [method: string, args: JmapArgs]

/**
 * One account's calls. `base` is the index its first call will have inside the request it lands in, so back
 * references (`resultOf: \`c${base}\``) point at the right call whichever batch it goes in.
 */
export type Group = (base: number) => Call[]

/**
 * Runs each group's calls, packing whole groups into requests of at most `maxCalls` calls, one request after
 * another. Returns each group's results in the order given. A group is never split, so its back references
 * stay inside one request; a group bigger than `maxCalls` goes alone and the server decides.
 */
export async function runGroups(
  groups: Group[],
  maxCalls: number,
  send: (calls: Call[]) => Promise<JmapArgs[]>,
): Promise<JmapArgs[][]> {
  const results: JmapArgs[][] = []
  let batch: Call[] = []
  let sizes: number[] = []

  const flush = async () => {
    if (!batch.length) return
    const out = await send(batch)
    let at = 0
    for (const size of sizes) {
      results.push(out.slice(at, at + size))
      at += size
    }
    batch = []
    sizes = []
  }

  for (const group of groups) {
    let calls = group(batch.length)
    if (batch.length && batch.length + calls.length > maxCalls) {
      await flush()
      calls = group(0)
    }
    batch.push(...calls)
    sizes.push(calls.length)
  }
  await flush()
  return results
}
