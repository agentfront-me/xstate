import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeName, encodeName, matches } from './names.ts'

test('modified UTF-7, both ways', () => {
  for (const [plain, encoded] of [['Sent', 'Sent'], ['Tom & Jerry', 'Tom &- Jerry'], ['Entwürfe', 'Entw&APw-rfe'], ['日本語', '&ZeVnLIqe-'], ['Töm/子', 'T&APY-m/&W1A-']] as const) {
    assert.equal(encodeName(plain), encoded)
    assert.equal(decodeName(encoded), plain)
  }
})

test('LIST patterns', () => {
  assert.equal(matches('*', 'Clients/Acme'), true)
  assert.equal(matches('%', 'Clients/Acme'), false)
  assert.equal(matches('%', 'Clients'), true)
  assert.equal(matches('Clients/%', 'Clients/Acme'), true)
  assert.equal(matches('inbox', 'INBOX'), true)
  assert.equal(matches('Sent', 'Sent Items'), false)
})
