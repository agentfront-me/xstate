import assert from 'node:assert/strict'
import { test } from 'node:test'
import { child, children, escapeXml, parseXml } from './xml.ts'

const D = 'DAV:'
const C = 'urn:ietf:params:xml:ns:caldav'

test('a PROPFIND with namespaces, as Apple Calendar sends it', () => {
  const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/><B:calendar-home-set xmlns:B="urn:ietf:params:xml:ns:caldav"/><A:displayname/></A:prop></A:propfind>`)!
  assert.equal(root.ns, D)
  assert.equal(root.name, 'propfind')
  const names = child(root, D, 'prop')!.children.map((c) => `${c.ns}|${c.name}`)
  assert.deepEqual(names, ['DAV:|current-user-principal', `${C}|calendar-home-set`, 'DAV:|displayname'])
})

test('a default namespace, text, entities, CDATA and comments', () => {
  const root = parseXml(`<sync-collection xmlns="DAV:"><!-- x --><sync-token>http://x/1?a=1&amp;b=2</sync-token><href><![CDATA[/a b.ics]]></href><sync-level>1</sync-level></sync-collection>`)!
  assert.equal(child(root, D, 'sync-token')!.text, 'http://x/1?a=1&b=2')
  assert.equal(child(root, D, 'href')!.text, '/a b.ics')
})

test('a calendar-query with a time range, found deep down', () => {
  const root = parseXml(`<c:calendar-query xmlns:d="DAV:" xmlns:c="${C}"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261101T000000Z" end="20261201T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`)!
  const range = child(root, C, 'time-range', true)!
  assert.deepEqual(range.attrs, { start: '20261101T000000Z', end: '20261201T000000Z' })
  assert.equal(children(child(root, D, 'prop'), D, 'getetag').length, 1)
})

test('broken input is null, not a crash', () => {
  assert.equal(parseXml('<a><b></a'), null)
  assert.equal(parseXml(''), null)
  assert.equal(escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;')
})
