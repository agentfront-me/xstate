// Folder names as IMAP carries them: modified UTF-7 (RFC 3501 §5.1.3), where anything outside printable ASCII is
// base64 of its UTF-16 between "&" and "-", and "&" itself is "&-". Pure, so the tests run under Node.

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\//g, ',')

export function encodeName(name: string): string {
  let out = ''
  let run: number[] = []
  const flush = () => {
    if (run.length) out += `&${b64(run)}-`
    run = []
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code >= 0x20 && code <= 0x7e) {
      flush()
      out += code === 0x26 ? '&-' : name[i]
    } else run.push(code >> 8, code & 0xff)
  }
  flush()
  return out
}

export function decodeName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, chunk: string) => {
    if (!chunk) return '&'
    try {
      const bin = atob(chunk.replace(/,/g, '/'))
      let s = ''
      for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1))
      return s
    } catch {
      return `&${chunk}-`
    }
  })
}

/** Whether a folder name matches a LIST pattern: `*` is anything, `%` anything but the "/" between levels. */
export function matches(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '[^/]*')
  return new RegExp(`^${re}$`, 'i').test(name)
}
