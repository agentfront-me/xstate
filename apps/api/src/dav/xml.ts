// Just enough XML for WebDAV and CalDAV requests (RFC 4918, RFC 4791): elements with namespaces resolved, text, and
// the entities XML always has. No DTDs. Pure, so the tests run under Node.

export type XmlNode = { ns: string; name: string; children: XmlNode[]; text: string; attrs: Record<string, string> }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  )

/** The root element, or null when the text isn't XML this can read. */
export function parseXml(text: string): XmlNode | null {
  const stack: { node: XmlNode; scope: Record<string, string> }[] = []
  let root: XmlNode | null = null
  let i = 0
  try {
    while (i < text.length) {
      const lt = text.indexOf('<', i)
      const chunk = text.slice(i, lt < 0 ? text.length : lt)
      if (chunk && stack.length) stack[stack.length - 1]!.node.text += decode(chunk)
      if (lt < 0) break
      if (text.startsWith('<!--', lt)) i = text.indexOf('-->', lt) + 3
      else if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt)
        if (stack.length) stack[stack.length - 1]!.node.text += text.slice(lt + 9, end)
        i = end + 3
      } else if (text.startsWith('<?', lt)) i = text.indexOf('?>', lt) + 2
      else if (text.startsWith('<!', lt)) i = text.indexOf('>', lt) + 1
      else if (text[lt + 1] === '/') {
        i = text.indexOf('>', lt) + 1
        const done = stack.pop()
        if (!done) return null
        if (!stack.length) root = done.node
      } else {
        const end = text.indexOf('>', lt)
        if (end < 0) return null
        const selfClosing = text[end - 1] === '/'
        const inner = text.slice(lt + 1, selfClosing ? end - 1 : end).trim()
        const [qname = '', ...rest] = inner.split(/\s+/)
        const attrs: Record<string, string> = {}
        for (const m of rest.join(' ').matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]!] = decode(m[3] ?? m[4] ?? '')
        const scope = { ...(stack[stack.length - 1]?.scope ?? {}) }
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'xmlns') scope[''] = v
          else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v
        }
        const colon = qname.indexOf(':')
        const prefix = colon < 0 ? '' : qname.slice(0, colon)
        const node: XmlNode = { ns: scope[prefix] ?? '', name: colon < 0 ? qname : qname.slice(colon + 1), children: [], text: '', attrs }
        if (stack.length) stack[stack.length - 1]!.node.children.push(node)
        if (selfClosing) {
          if (!stack.length) root = node
        } else stack.push({ node, scope })
        i = end + 1
      }
      if (i <= 0) return null
    }
  } catch {
    return null
  }
  return root
}

/** The first child (or descendant, with `deep`) with this namespace and name. */
export function child(node: XmlNode | null | undefined, ns: string, name: string, deep = false): XmlNode | null {
  if (!node) return null
  for (const c of node.children) {
    if (c.ns === ns && c.name === name) return c
    if (deep) {
      const found = child(c, ns, name, true)
      if (found) return found
    }
  }
  return null
}

export const children = (node: XmlNode | null | undefined, ns: string, name: string) => (node?.children ?? []).filter((c) => c.ns === ns && c.name === name)

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
