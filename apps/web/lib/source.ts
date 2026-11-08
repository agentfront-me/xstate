// The docs: every .md file in content/docs becomes a page under /docs. Folder order and titles come from
// meta.json files (see content/docs/meta.json); a page's title and description come from its frontmatter.
import { loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'

const docs = defineDocs({ dir: 'content/docs' })

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})

type Page = NonNullable<ReturnType<typeof source.getPage>>

/** Where a page's Markdown is served: /docs.md for the docs home, /docs/<page>.md for the rest. */
export const markdownUrl = (page: Page) => `${page.url}.md`

// The .md files as written, bundled at build time: the Worker that serves them has no file system.
const files = import.meta.glob<string>('../content/docs/**/*.md', { query: '?raw', import: 'default', eager: true })

/** A page as Markdown: its title, then the file as written, without the frontmatter. */
export function pageMarkdown(page: Page) {
  const raw = files[`../content/docs/${page.path}`] ?? ''
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  const intro = page.data.description ? `\n\n> ${page.data.description}` : ''
  return `# ${page.data.title}${intro}\n\n${body}\n`
}

/** /llms.txt: one line per page, linking to its Markdown. */
export function llmsIndex() {
  const lines = source
    .getPages()
    .map((p) => `- [${p.data.title}](https://xstate.com${markdownUrl(p)})${p.data.description ? `: ${p.data.description}` : ''}`)
  return `# xstate\n\n> Email, data, agents and sites on your own domain.\n\n## Docs\n\n${lines.join('\n')}\n`
}
