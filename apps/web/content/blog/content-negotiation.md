---
title: 'One URL, three formats: this blog answers to the Accept header'
summary: Every post is HTML for people, and Markdown or JSON for agents, at the same address.
date: 2026-11-17
author: xstate
tags: [agents, web]
---

More and more of the readers of a page like this one are not people. They are agents: Claude, Codex or Cursor
looking something up for someone, or a script that keeps a list of posts in sync. Those readers don't want our
header, our footer or the theme toggle. They want the words.

So every post on this blog is available in three formats at the same URL. A browser gets HTML. Anything that asks
for Markdown or JSON gets that instead.

## Try it

```bash
# The page, as a browser sees it
curl https://xstate.com/blog/content-negotiation

# The post as Markdown
curl -H 'Accept: text/markdown' https://xstate.com/blog/content-negotiation

# The post as JSON: title, summary, date, tags, and the Markdown
curl -H 'Accept: application/json' https://xstate.com/blog/content-negotiation
```

The same works for the changelog, and `/blog` with `Accept: application/json` returns the whole blog as a
[JSON Feed](https://jsonfeed.org).

## Files too, for tools that can't set headers

Some tools fetch a URL and can't choose its headers. For them, each format also has its own address:

| Format | Address |
| - | - |
| HTML | `/blog/<post>` |
| Markdown | `/blog/<post>.md` |
| JSON | `/blog/<post>.json` |
| All posts | `/blog/feed.json` and `/blog/rss.xml` |
| Changelog | `/changelog`, `/changelog.md`, `/changelog.json` |

The docs work the same way through their own files: `/docs/mcp` is the page and `/docs/mcp.md` is its Markdown. And
[`/llms.txt`](/llms.txt) lists every docs page and post with a link to its Markdown, so an agent can find what it
needs without crawling.

## Browsers never notice

The rule is simple. If a request's `Accept` header includes `text/html`, it gets the page. Every browser sends
`text/html`, so people always see the page they expect, and nothing changes for search engines.

Only a request that asks for JSON or Markdown and *not* HTML gets the other format. Those responses carry
`Vary: Accept`, so a cache never serves one format to a reader who asked for another.

## Getting Markdown right

The Markdown we serve is the file the post was written in, not HTML converted back. Converting a rendered page
loses things: tables turn into runs of text, code blocks lose their language, and the navigation leaks into the
content. Serving the source avoids all of that. We make two changes on the way out:

- **The title and summary go on top**, followed by a line with the date, read time, tags and author. In the file
  they live in frontmatter, which a reader shouldn't have to parse.
- **Links become absolute.** In the file, a link to the docs is written `/docs/mcp`. Pasted into a conversation
  with an agent, that path means nothing, so it becomes `https://xstate.com/docs/mcp`.

The JSON version carries the same Markdown in `content_markdown`, next to the fields a script would want on their
own: `title`, `summary`, `date`, `updated`, `tags` and `minutes`.

## Why bother

An agent that reads Markdown spends its context on the content instead of on markup, and gets the structure
(headings, tables, code) intact. A script that reads JSON doesn't have to scrape. And people lose nothing: the
page is still a page.

We build xstate for people who work with agents, so the site they read about it on should work for their agents
too. The blog and changelog do today, the docs have Markdown files, and we'll bring the rest of the site to the
same rule.
