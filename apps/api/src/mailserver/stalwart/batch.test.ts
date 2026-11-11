import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runGroups, type Call, type Group } from './batch.ts'

// A fake server: answers each call with its method, its index in the request and the reference it carried.
function server() {
  const requests: Call[][] = []
  const send = async (calls: Call[]) => {
    requests.push(calls)
    return calls.map(([method, args], i) => ({ method, at: i, ref: (args['#ids'] as { resultOf?: string } | undefined)?.resultOf ?? null }))
  }
  return { requests, send }
}

// Like All inboxes: query, get that query's ids, get those emails' threads.
const query = (account: string): Group => (base) => [
  ['Email/query', { accountId: account }],
  ['Email/get', { accountId: account, '#ids': { resultOf: `c${base}` } }],
  ['Thread/get', { accountId: account, '#ids': { resultOf: `c${base + 1}` } }],
]

describe('runGroups', () => {
  it('sends everything in one request when it fits', async () => {
    const s = server()
    const out = await runGroups(['a', 'b', 'c', 'd', 'e'].map(query), 16, s.send)
    assert.equal(s.requests.length, 1)
    assert.equal(s.requests[0]!.length, 15)
    assert.equal(out.length, 5)
  })

  it('splits 6 mailboxes (18 calls) under a limit of 16 without splitting a mailbox', async () => {
    const s = server()
    const accounts = ['a', 'b', 'c', 'd', 'e', 'f']
    const out = await runGroups(accounts.map(query), 16, s.send)
    assert.deepEqual(s.requests.map((r) => r.length), [15, 3])
    assert.ok(s.requests.every((r) => r.length <= 16))
    // Results come back per mailbox, in order, three each.
    assert.deepEqual(out.map((r) => r.length), [3, 3, 3, 3, 3, 3])
    assert.deepEqual(out.map((r) => r.map((x) => x.method)), Array(6).fill(['Email/query', 'Email/get', 'Thread/get']))
  })

  it('rebases back references to each request', async () => {
    const s = server()
    const out = await runGroups(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(query), 6, s.send)
    assert.deepEqual(s.requests.map((r) => r.length), [6, 6, 6, 3])
    for (const request of s.requests) {
      for (let i = 0; i < request.length; i += 3) {
        assert.equal((request[i + 1]![1]['#ids'] as { resultOf: string }).resultOf, `c${i}`)
        assert.equal((request[i + 2]![1]['#ids'] as { resultOf: string }).resultOf, `c${i + 1}`)
      }
    }
    // The 7th mailbox is first in its request, so its get refers to c0.
    assert.equal(out[6]![1]!.ref, 'c0')
    assert.equal(out[6]![2]!.ref, 'c1')
  })

  it('keeps results with their accounts across requests', async () => {
    const s = server()
    const single = (account: string): Group => () => [['Email/get', { accountId: account, ids: [] }]]
    const send = async (calls: Call[]) => calls.map(([, args]) => ({ state: `s-${String(args.accountId)}` }))
    const out = await runGroups(['a', 'b', 'c', 'd', 'e'].map(single), 2, send)
    assert.deepEqual(out.map((r) => r[0]!.state), ['s-a', 's-b', 's-c', 's-d', 's-e'])
    assert.equal(s.requests.length, 0)
  })

  it('sends a group bigger than the limit on its own', async () => {
    const s = server()
    await runGroups([query('a'), query('b')], 2, s.send)
    assert.deepEqual(s.requests.map((r) => r.length), [3, 3])
  })

  it('makes no request for no groups', async () => {
    const s = server()
    assert.deepEqual(await runGroups([], 16, s.send), [])
    assert.equal(s.requests.length, 0)
  })
})
