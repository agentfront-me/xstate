// The body of one email. HTML mail is drawn in a web view, the way the web app draws it in a sandboxed frame: no
// scripts from the email run, remote images load only once the reader asks, and links open in the browser. Simple
// mail (no tables, images or colours of its own) takes the app's colours; designed mail gets a white card.
// Mail with no HTML part shows its text, tidied.

import { useMemo, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { c } from './theme'

/** Same test as the web app (apps/app/src/mail/quotes.ts). */
const isPlainHtml = (html: string) => !/<table|bgcolor\s*=|background(-color|-image)?\s*:|<img/i.test(html)

export const hasRemoteImages = (html: string | null) => !!html && /<img[^>]+src\s*=\s*["']?https?:/i.test(html)

function page(html: string, plain: boolean, showImages: boolean): string {
  const images = showImages ? 'https: http: data:' : 'data:'
  const base = plain
    ? `html,body{background:transparent;color:${c.soft}}body{padding:0}
       body *{color:inherit!important;background-color:transparent!important;font-family:inherit!important}
       a{color:${c.text}!important;text-decoration:underline}
       blockquote{margin:6px 0;padding-left:12px;border-left:2px solid ${c.borderStrong};opacity:.8}`
    : `html,body{background:#fff;color:#18181b}body{padding:8px}a{color:#2563eb}`
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:">
    <style>html,body{margin:0;font:16px/1.5 -apple-system,system-ui,Roboto,sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
    ${base}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}
    img[src^="cid:"]{display:none}
    ${showImages ? '' : 'img[src^="http:"],img[src^="https:"]{display:none}'}</style></head>
    <body>${html}</body></html>`
}

// Ours, not the email's: reports the page's height so the view can be exactly that tall, and again when it changes
// (an image arriving, text wrapping).
const MEASURE = `(function(){
  function send(){window.ReactNativeWebView.postMessage(String(Math.ceil(document.documentElement.scrollHeight)))}
  send();window.addEventListener('load',send);
  if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);
  setTimeout(send,300);setTimeout(send,1200);
})();true;`

/** Plain-text mail is hard-wrapped and often indented for a fixed-width screen: drop the indents, keep the paragraphs. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) =>
      p
        .split('\n')
        .map((line) => line.trim())
        // A quoted or list line keeps its own line; ordinary wrapped lines join into one paragraph.
        .reduce((out, line) => (out && !/^(>|[-*•]\s|\d+[.)]\s)/.test(line) ? `${out} ${line}` : out ? `${out}\n${line}` : line), ''),
    )
    .filter(Boolean)
    .join('\n\n')
}

export function MessageBody({ html, text, showImages }: { html: string | null; text: string; showImages: boolean }) {
  const [height, setHeight] = useState(80)
  const plain = html ? isPlainHtml(html) : true
  const source = useMemo(() => (html ? { html: page(html, plain, showImages) } : null), [html, plain, showImages])

  if (!source) {
    return (
      <Text selectable style={s.text}>
        {tidyText(text)}
      </Text>
    )
  }
  return (
    <View style={[{ height }, !plain && s.card]}>
      <WebView
        source={source}
        originWhitelist={['*']}
        style={{ backgroundColor: 'transparent' }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        injectedJavaScript={MEASURE}
        onMessage={(e) => {
          const h = Number(e.nativeEvent.data)
          if (h > 0 && Math.abs(h - height) > 1) setHeight(h)
        }}
        // The email is the only page this view shows: any link opens outside the app.
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === 'about:blank' || request.url.startsWith('about:') || request.url.startsWith('data:')) return true
          if (/^(https?|mailto|tel):/i.test(request.url)) void Linking.openURL(request.url).catch(() => undefined)
          return false
        }}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        dataDetectorTypes="none"
      />
    </View>
  )
}

const s = StyleSheet.create({
  text: { color: c.soft, fontSize: 16, lineHeight: 24 },
  card: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
})
