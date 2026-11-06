// 2 · Your domain.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, DOMAIN_RE, errorMessage } from '../lib/core'
import type { Domain } from '../lib/types'
import { setProgress, type Data, type Provider } from './state'
import { Head, Help, usePending, type Message } from './ui'

type DomainCheck = { name: string; taken: boolean; registered: boolean; provider: Provider | null }

/** Accepts what people paste: 'https://www.Example.com/about' → 'example.com'. */
function cleanDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
}

export function DomainStep({ data, update, next }: { data: Data; update: (patch: Partial<Data>) => void; next: () => void }) {
  const [value, setValue] = useState(data.domain?.name ?? '')
  const [error, setError] = useState<Message>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [noDomain, setNoDomain] = useState<Message>(null)
  const [pending, run] = usePending()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const fail = (text: string) => {
    setError({ text })
    input.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const name = cleanDomain(value)
    if (!name) return fail('Enter your domain, like yourbusiness.com.')
    if (!DOMAIN_RE.test(name)) return fail("That doesn't look like a domain. Try something like yourbusiness.com.")
    setValue(name)
    setError(null)
    setChecking(name)

    let done = false
    await run(async () => {
      try {
        const result = await api<DomainCheck>('GET', `/email/domain-check?name=${encodeURIComponent(name)}`)
        let domain = data.domain
        const ours = domain?.name === result.name
        if (result.taken && !ours) return fail(`${result.name} is already on xstate. If it's yours, sign in to that account.`)
        if (!result.registered) return fail(`We couldn't find ${result.name}. Check the spelling, or register it first.`)
        if (!ours) {
          // Changing the domain before any address uses it: swap the old one out.
          if (domain) await api('DELETE', `/email/domains/${domain.id}`)
          update({ domain: null })
          domain = (await api<{ domain: Domain }>('POST', `/email/orgs/${data.org.id}/domains`, { name: result.name })).domain
        }
        if (!domain) return
        update({ domain, provider: result.provider })
        setProgress({ provider: { domainId: domain.id, ...result.provider } })
        done = true
      } catch (err) {
        fail(errorMessage(err))
      }
    })
    setChecking(null)
    if (done) next()
  }

  return (
    <>
      <Head title="What's your business domain?" sub="Your email addresses will end in this. You keep full ownership." />
      <form className="stack-8" id="form" noValidate onSubmit={submit}>
        <span className={`input on-panel${error ? ' is-error' : ''}`} id="domain-box">
          <input
            ref={input}
            name="domain"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="yourbusiness.com"
            aria-label="Domain"
            aria-describedby="domain-help"
            value={value}
            readOnly={!!checking}
            onChange={(event) => {
              // Nothing is looked up while typing: editing only clears an earlier error.
              setValue(event.target.value)
              setError(null)
            }}
          />
        </span>
        <Help id="domain-help" message={error} />
      </form>
      <button className="btn btn-primary" id="continue" form="form" type="submit" disabled={pending} aria-busy={pending || undefined}>
        {checking ? (
          <>
            <span className="spinner spinner-on-primary" />
            Checking {checking}…
          </>
        ) : (
          'Continue'
        )}
      </button>
      <a
        className="link"
        href="#"
        id="no-domain"
        onClick={(event) => {
          event.preventDefault()
          setNoDomain({
            text: 'Buying a domain or starting on a free xstate subdomain is coming soon. For now, use a domain you own.',
            kind: 'info',
          })
        }}
      >
        I don't have a domain
      </a>
      <Help id="no-domain-help" message={noDomain} />
    </>
  )
}
