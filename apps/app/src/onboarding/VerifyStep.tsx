// 3 · Verify your domain. Polls the DNS check every few seconds until every required record is found, and offers
// one-click setup (Domain Connect) when the domain's DNS provider supports it.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { api, ApiError, copyText } from '../lib/core'
import type { DnsRecord, Domain } from '../lib/types'
import { clearConnectReturn, connectReturn, domainName, POLL_MS, progress, setProgress, type Data } from './state'
import { Back, useCopied } from './ui'

const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']

type Connect = { applyUrl: string; name: string; note: string; primary: boolean }

/** One copyable line of a DNS record: a label, the text, and a copy button. Clicking the text copies too. */
function RecordField({ label, text }: { label: string; text: string }) {
  const [copied, copy] = useCopied()
  const lower = label.toLowerCase()
  return (
    <div className="rec-field">
      <span className="rec-label">{label}</span>
      <button type="button" className="cell" title={`Copy ${lower}`} onClick={() => void copy(text)}>
        {text}
      </button>
      <button type="button" className="copy" aria-label={`Copy ${lower}`} onClick={() => void copy(text)}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )
}

/**
 * Shown when the domain's DNS is on Cloudflare: a link straight to the zone's DNS page, for adding the records by
 * hand. One-click setup (Domain Connect), when the API offers it, goes above this.
 */
function CloudflarePanel({ domain, connected }: { domain: string; connected: boolean }) {
  const url = `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(domain)}/dns/records`
  return (
    <div className="panel">
      <div className="panel-section">
        <div className="hi" id="manual-title">
          {connected ? 'Or add the records yourself' : 'Your DNS is on Cloudflare'}
        </div>
        <div className="small muted">
          Open your DNS settings, choose <span className="hi">Add record</span> for each record below, and paste in its name and value. Leave
          CNAME records as <span className="hi">DNS only</span> (grey cloud).
        </div>
        <a className="btn" href={url} target="_blank" rel="noopener">
          <Icon name="external-link" size={14} />
          Open Cloudflare DNS
        </a>
      </div>
    </div>
  )
}

export function VerifyStep({
  data,
  update,
  back,
  next,
}: {
  data: Data
  update: (patch: Partial<Data>) => void
  back: () => void
  next: () => void
}) {
  const domain = domainName(data)
  const domainId = data.domain!.id
  const saved = progress().provider
  const provider = data.provider ?? (saved?.domainId === domainId && saved.name ? saved : null)
  const where = provider?.name ?? 'your domain provider'
  const done = data.domain?.status === 'verified'

  const [records, setRecords] = useState<DnsRecord[] | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [connect, setConnect] = useState<Connect | null>(null)
  const [zoneText, setZoneText] = useState('Copy every record as a zone file')
  const status = useRef(data.domain?.status)
  status.current = data.domain?.status

  // The DNS check: right away, then every few seconds until verified or the step is left.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await api<{ domain: Domain; records: DnsRecord[] }>('POST', `/email/domains/${domainId}/verify`)
        if (cancelled) return
        status.current = result.domain.status
        update({ domain: result.domain })
        setRecords(result.records)
        setCheckFailed(false)
      } catch (err) {
        if (cancelled || (err instanceof ApiError && err.code === 'signed_out')) return
        setCheckFailed(true)
      }
      if (!cancelled && status.current !== 'verified') timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [domainId])

  // Domain Connect: when the domain's DNS provider supports our template, a button that sends the person there to
  // approve every record in one click. No link (unsupported provider, template not onboarded) changes nothing. On
  // the web the provider sends the browser back to /signup, which resumes here; the desktop app opens the provider
  // in the browser instead and keeps polling.
  const returned = useRef(connectReturn?.state === domainId ? connectReturn : null)
  useEffect(() => {
    clearConnectReturn()
    if (status.current === 'verified') return
    let cancelled = false
    const web = /^https?:$/.test(location.protocol)
    // The Domain Connect template only allows returns to xstate.com (syncRedirectDomain), so on go.xstate.com
    // the provider sends people to xstate.com/signup, which redirects back here with the query intact.
    const back = location.hostname === 'go.xstate.com' ? 'https://xstate.com' : location.origin
    const query = web ? `?redirectUri=${encodeURIComponent(`${back}/signup`)}` : ''
    api<{ applyUrl?: string | null; provider?: string | null }>('GET', `/email/domains/${domainId}/domain-connect${query}`)
      .then((result) => {
        if (cancelled || !result?.applyUrl || status.current === 'verified') return
        const name = result.provider ?? provider?.name ?? 'your DNS provider'
        const r = returned.current
        const note = !r
          ? `Sign in to ${name} and approve. It adds every record below for you.`
          : r.error
            ? r.error === 'access_denied'
              ? `${name} didn't add the records. Try again, or add them yourself below.`
              : `${name} couldn't add the records (${r.error}). Try again, or add them yourself below.`
            : `${name} is adding your records. We'll confirm as soon as they show up in DNS.`
        setConnect({ applyUrl: result.applyUrl, name, note, primary: !(r && !r.error) })
      })
      .catch(() => {
        // One-click setup is optional; the records below still work.
      })
    return () => {
      cancelled = true
    }
  }, [domainId])

  const copyZone = async () => {
    try {
      const { zoneFile } = await api<{ zoneFile: string }>('GET', `/email/domains/${domainId}/dns`)
      if (!(await copyText(zoneFile))) throw new Error("Couldn't copy the zone file")
      setZoneText('Copied. Most DNS providers can import it.')
    } catch (err) {
      setZoneText(err instanceof Error ? err.message : "Couldn't copy the zone file")
    }
  }

  // Onboarding moves mail now; the ownership record is only for starting a Google import before the switch.
  const list = (records ?? []).filter((r) => r.purpose !== 'Ownership')
  const required = list.filter((r) => r.required)
  const found = required.filter((r) => r.found).length
  const missing = required.filter((r) => !r.found)
  const web = /^https?:$/.test(location.protocol)
  const showConnect = !!connect && !done

  const statusText = checkFailed
    ? `Couldn't check DNS just now. Trying again…`
    : !records
      ? 'Looking up your DNS…'
      : !found
        ? 'Checking DNS… this usually takes a few minutes.'
        : missing.length === 1
          ? `${found} of ${required.length} records found. Still checking the ${missing[0]!.purpose} record…`
          : `${found} of ${required.length} records found. Still checking the rest…`

  const developerHref = (() => {
    const body =
      `Hi,\n\nPlease add these DNS records for ${domain} so our email works with xstate:\n\n` +
      list.map((r) => `${r.type}  ${r.name}  ${r.value}`).join('\n') +
      `\n\nName "@" means the domain itself (${domain}). Thanks!`
    return `mailto:?subject=${encodeURIComponent(`DNS records for ${domain}`)}&body=${encodeURIComponent(body)}`
  })()

  return (
    <>
      <Back onClick={back} />
      <div className="head">
        <h1 id="title">{records && done ? 'Your domain is connected' : 'Verify your domain'}</h1>
        <p id="sub">
          {!records
            ? `Checking ${domain}…`
            : done
              ? `${domain} now sends and receives email through xstate.`
              : `Add these ${NUMBERS[list.length] ?? list.length} records at ${where}. We check automatically, so you can leave this page open.`}
        </p>
      </div>
      <div className="panel" id="connect" hidden={!showConnect}>
        {showConnect && (
          <div className="panel-section">
            <div className="hi">Set up in one click</div>
            <div className="small muted">{connect.note}</div>
            <a
              className={`btn${connect.primary ? ' btn-primary' : ''}`}
              href={connect.applyUrl}
              {...(web ? {} : { target: '_blank', rel: 'noopener' })}
            >
              Connect with {connect.name}
            </a>
          </div>
        )}
      </div>
      {provider?.id === 'cloudflare' && <CloudflarePanel domain={domain} connected={showConnect} />}
      <div className="records" id="records" hidden={!records}>
        {list.map((r, i) => (
          <div className="rec" key={i}>
            <div className="rec-top">
              <span className={r.found ? 'ok' : 'wait'} title={r.found ? 'Found' : 'Not found yet'}>
                <Icon name={r.found ? 'circle-check' : 'circle-dashed'} size={14} />
              </span>
              <span className="type">{r.type}</span>
              <span className="dim">
                {r.purpose}
                {r.required ? '' : ' · recommended'}
              </span>
              <span className="rec-state">{r.found ? 'Found' : 'Not found yet'}</span>
            </div>
            <RecordField label="Name" text={r.name} />
            <RecordField label="Value" text={r.value} />
          </div>
        ))}
      </div>
      <a
        className="link"
        href="#"
        id="zone"
        hidden={!records || done}
        onClick={(event) => {
          event.preventDefault()
          void copyZone()
        }}
      >
        {zoneText}
      </a>
      <div className={`status${records && done ? ' is-done' : ''}`} id="status" role="status">
        {records && done ? (
          <>
            <Icon name="circle-check" size={14} />
            <span>All records found. Verified just now.</span>
          </>
        ) : (
          <>
            <span className="spinner" />
            <span>{statusText}</span>
          </>
        )}
      </div>
      <div className="stack" id="actions">
        {records &&
          (done ? (
            <button className="btn btn-primary" id="next" onClick={next}>
              Continue
            </button>
          ) : (
            <>
              <a className="btn" id="developer" href={developerHref}>
                <Icon name="send" size={14} />
                Send these to my developer
              </a>
              <a
                className="link"
                href="#"
                id="skip"
                onClick={(event) => {
                  event.preventDefault()
                  setProgress({ skippedVerify: domainId })
                  next()
                }}
              >
                Skip, I'll do this later
              </a>
            </>
          ))}
      </div>
    </>
  )
}
