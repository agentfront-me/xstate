import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAppPassword, hashAppPassword, newAppPassword, normalizeAppPassword } from './app-password-rules.ts'

test('a new app password is 16 lowercase letters, different each time', () => {
  const a = newAppPassword()
  assert.match(a, /^[a-z]{16}$/)
  assert.notEqual(a, newAppPassword())
})

test('shown in four groups, and read back however it was typed', () => {
  const shown = formatAppPassword('abcdefghijklmnop')
  assert.equal(shown, 'abcd-efgh-ijkl-mnop')
  assert.equal(normalizeAppPassword(shown), 'abcdefghijklmnop')
  assert.equal(normalizeAppPassword('ABCD efgh  ijkl mnop'), 'abcdefghijklmnop')
  assert.equal(normalizeAppPassword(' abcdefghijklmnop '), 'abcdefghijklmnop')
})

test('anything else is not an app password', () => {
  for (const typed of ['', 'abcd-efgh-ijkl', 'abcd-efgh-ijkl-mnop-qrst', 'abcd-efgh-ijkl-mno1', 'my account password!']) {
    assert.equal(normalizeAppPassword(typed), null, typed)
  }
})

test('the hash is hex SHA-256', async () => {
  assert.equal(await hashAppPassword('abcdefghijklmnop'), 'f39dac6cbaba535e2c207cd0cd8f154974223c848f727f98b3564cea569b41cf')
})
