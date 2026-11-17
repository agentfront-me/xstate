# xstate Brand Voice Guidelines

## Generation Metadata
- Created: 2026-11-17
- Version: 1.2 (2026-11-17: agent vs AI app settled; primary reader set to founders and small teams)
- Sources: xstate.com homepage, header and footer, pricing table; 3 published blog posts (plus 1 draft); 2 changelog entries; docs pages Overview, Quickstart, Connect AI apps, Security, Privacy (see Appendix)
- Documents processed: 12
- Conversations analyzed: 0 (no transcripts available)
- Discovery report used: No
- Overall confidence: **Medium** (0.60). Guidelines are derived from patterns in published content. No written style guide existed before this one.

---

## Executive Summary

xstate sounds like a careful engineer explaining something to a smart colleague: plain words, short sentences,
exact numbers and no hype. It says what the product does, what it doesn't do and why it was built that way.
The best pieces ("What an AI app can do with your mail", the Security page) earn trust by being specific. They
give the actual limit, the actual default and the actual reason, and they never use an adjective where a fact will do.

The second trait is **control**. Almost every piece is organized around what *you* choose: which mailboxes, which
permissions, when a token ends, how to take access back. xstate is honest that giving an AI app your inbox is a real
decision, and it treats the reader as the person who makes it.

The third trait is that xstate is **built for people who work with agents**, and it shows this rather than claiming it.
There are curl examples and Markdown versions of every page, and settings are named exactly as they appear in the
app. Technical depth goes up or down with the context, but the voice stays the same: calm, concrete, honest and on
the reader's side.

---

## Audience

- **Primary reader: founders and small teams who already use AI tools** (Claude, ChatGPT, Cursor). They run a
  business, not a mail server. They care about getting email working on their domain, about what an AI app can do
  with their mail, and about price. Write homepage, landing page, pricing, onboarding and outreach copy for them.
- **Secondary reader: developers**, often on the same team. They want the MCP address, the API, curl examples
  and machine-readable pages. Serve them in the docs, the blog, the changelog and the footer.
- **Rule:** keep developer detail (curl, MCP, JSON, llms.txt) out of hero sections and main calls to action. Mention
  MCP by name only where the reader is connecting something. Elsewhere, say "connect Claude, Codex or Cursor".
- **Test:** could a founder who has never opened a terminal read the sentence and know what they get? If not, move
  it to the docs or rewrite it.

---

## We Are / We Are Not

| We Are | We Are Not |
|--------|------------|
| **Plain-spoken**: short sentences, everyday words, one idea at a time | **Jargon-heavy or corporate**: "leverage", "seamless", "solutions" |
| **Specific**: real numbers, real defaults, real names of settings | **Vague**: "secure", "fast", "powerful" without a fact behind it |
| **Honest about limits**: we say what it isn't for and what's not built yet | **Overpromising**: "forever", "unbreakable", claims about features that aren't built |
| **On the reader's side**: you choose, you can undo, we explain the safe default | **Paternalistic or fear-selling**: lecturing, scare tactics about AI |
| **Agent-native**: we show the curl, the Markdown, the MCP address | **AI-hype**: "revolutionary AI", "supercharge", "magic" |
| **Calm and confident**: no exclamation marks, no superlatives | **Salesy**: urgency, "best-in-class", "game-changing" |
| **Explains the why**: one short reason after a decision | **Long-winded**: a paragraph of preamble before the point |

### Voice Attributes Detail

#### 1. Plain-spoken
- **What it means**: Write as a person would say it aloud. Short sentences, everyday words, active voice.
- **How it shows up**: "Disconnect ends its access at once." / "Copy it once." / "Most domains are ready within a few minutes."
- **What to avoid**: Nouns stacked into jargon ("permission scoping framework"), passive constructions ("access is revoked").
- **Evidence**: Consistent across the blog, Quickstart, Security and the changelog. Steps are imperative, and paragraphs average 2–4 sentences.
- **Confidence**: Medium (consistent in 10+ sources, never written down as a rule)

#### 2. Specific
- **What it means**: Replace every claim with the fact that proves it.
- **How it shows up**: "limited to 5 a minute for each email address and 10 a minute from each network"; "Connections also end on their own 30 days after their last use"; "a salted PBKDF2-SHA256 hash with 100,000 iterations".
- **What to avoid**: "Enterprise-grade security", "blazing fast", "lots of storage".
- **Evidence**: Security page, agent-permissions post, transactional email post, pricing table.
- **Confidence**: Medium

#### 3. Honest about limits
- **What it means**: Say what the product doesn't do, what's not ready and what it isn't for, in the same breath as what it does.
- **How it shows up**: "It isn't for newsletters or other bulk mail." / "Some things are never available to a connected app, whatever you choose" / "Buying one during setup and a free xstate subdomain are coming." / "This page describes what xstate actually does".
- **What to avoid**: Claiming planned features as live, "forever" promises, legal or security wording that goes beyond what's built.
- **Evidence**: FAQ, transactional email post, agent-permissions post, Security page intro, the unpublished draft held back until it has "real verification times from production".
- **Confidence**: Medium

#### 4. On the reader's side
- **What it means**: Frame features as choices the reader makes, defaults as the narrowest useful option, and always show the way back.
- **How it shows up**: "You approve every app" / "You choose what it may do" / "Every choice starts at the narrowest setting that is still useful." / "Taking access back".
- **What to avoid**: Fear ("hackers are coming for your inbox"), or decisions made for the reader without explaining them.
- **Evidence**: Section headings of the agent-permissions post, Connect AI apps docs, the Personal tokens section.
- **Confidence**: Medium

#### 5. Agent-native
- **What it means**: The product is built for people who work with AI agents, and the writing proves it with working examples rather than claims.
- **How it shows up**: curl blocks that run as pasted; "add `.md` to its URL"; the MCP address in a code block near the top of the page.
- **What to avoid**: Calling it "AI-powered" in general terms; AI as decoration.
- **Evidence**: Content negotiation post, transactional email post, docs index "For agents", footer "Machine readable".
- **Confidence**: Medium

#### 6. Explains the why
- **What it means**: After a non-obvious decision, give one short reason.
- **How it shows up**: "We made this the default because email is written by other people." / "so an app you tried once and forgot doesn't keep access forever." / the "Why bother" section.
- **What to avoid**: Defending at length, or giving no reason at all for a surprising default.
- **Evidence**: Agent-permissions post, content negotiation post, Security page.
- **Confidence**: Medium

---

## Brand Personality

- **Archetype**: The careful engineer. Technically deep, never condescending, always tells you the trade-off.
- **If xstate were a person**: the colleague who set up your company's email properly. They answer a question with
  the exact setting and the reason for it, warn you once about the risky option, and then let you decide.
- **Core values expressed in voice**: control stays with the customer, honesty over polish, small safe defaults,
  data you can take with you, and working well for both people and agents.

---

## Messaging Framework (Confidence: Medium)

### Primary Value Proposition
**Business email, calendar and files on your own domain, with AI apps that can only do what you allow.**

Variations observed:
- "Business email your AI can work in, on your own domain." (Homepage H1, 2026-11-17)
- "Email on your own domain, with agents that can work in it." (Docs index description)
- "xstate gives you business email on a domain you own, plus a calendar, file storage and contacts on the same account, and lets AI agents … work with it under permissions you choose." (Docs index)

### Key Message Pillars

1. **Your domain, working in minutes**
   - Core idea: Bring a domain you own and get a working inbox in minutes, with DNS that checks itself.
   - When to use: Homepage, onboarding, Quickstart, ads.
   - Example phrasing: "Connect a domain. Inbox in minutes."

2. **AI apps with the access you choose**
   - Core idea: Connect Claude, Codex, Cursor or ChatGPT. You pick the mailboxes and what each one may do, and sending starts off.
   - When to use: Anywhere AI is mentioned; this is the main differentiator.
   - Example phrasing: "A draft hurts nobody until a person sends it."

3. **Built for people who work with agents**
   - Core idea: Pages, docs and the API work for agents and scripts as well as people.
   - When to use: Developer audiences, blog, docs, changelog.
   - Example phrasing: "We build xstate for people who work with agents, so the site they read about it on should work for their agents too."

4. **Fair and yours to take**
   - Core idea: Free for up to 5 people, simple per-person pricing, export everything at any time.
   - When to use: Pricing, closing calls to action, comparisons.
   - Example phrasing: "No card on the free plan. Export everything, any time."

### Competitive Positioning
- **vs. Google Workspace**: built for AI from the start, with per-app, per-mailbox permissions, AI search across
  mail and files included, free for up to 5 people, and a one-step import to move across. Name Google factually and
  never disparage it.
- **vs. separate transactional email services**: receipts go out from an address people actually write to, so replies
  "land in a real inbox" instead of `noreply@`.
- **vs. giving an AI app full access to your Gmail**: access is limited to the mailboxes you pick, sending is off by
  default, and connections end on their own after 30 days without use.

---

## Tone-by-Context Matrix (Confidence: Medium for published contexts, Low for sales and social)

The voice stays the same everywhere. Tone changes by context.

| Context | Formality | Energy | Technical Depth | Key Principle |
|---------|-----------|--------|-----------------|---------------|
| Homepage and landing pages | Medium | Medium-High | Low | The benefit first, then one proof |
| Docs | Medium | Low | High | Steps, exact names, nothing extra |
| Blog | Medium-Low | Medium | Medium-High | Explain a decision and its reason |
| Changelog | Medium | Low | Medium | One line for each change, with a link |
| In-app UI, errors, empty states | Medium | Low | Low | What happened, why, what to do |
| Security, Privacy, Terms | High | Low | High | Only what's true today, plainly |
| Support email | Medium-Low | Warm | Medium | Answer first, then the cause |
| Cold outreach (founder) | Low-Medium | Medium | Low | One concrete reason to care |
| Sales proposal or team pitch | Medium-High | Medium | Medium | Facts, limits and price in a table |
| Social media | Low | Medium-High | Low-Medium | One idea, one example, one link |

### Context-Specific Guidelines

#### Homepage and landing pages
- **Overall tone**: confident, benefit-led, short.
- **Do's**: lead with what the reader gets; put "free for up to 5 people" early; use one label per action ("Start free" everywhere).
- **Don'ts**: taglines that need explaining ("Your Digital Real Estate"); copy addressed to crawlers or agents in the main flow.
- **Example**: "Business email your AI can work in, on your own domain."

#### Docs
- **Overall tone**: neutral and procedural.
- **Do's**: numbered steps; name settings exactly as they appear in the app, in bold, with arrows (**Settings → API keys → Personal Tokens**); give the address or command in a code block near the top.
- **Don'ts**: marketing adjectives; assuming steps the reader hasn't done.
- **Example**: "Copy them into your DNS provider, or copy them all at once as a zone file, which most providers can import."

#### Blog
- **Overall tone**: first person plural ("we"), open about the reasoning.
- **Opening approach**: start with the reader's problem or the decision, in 1–2 sentences, with no warm-up.
- **Do's**: title says the point ("…and why send is off by default"); a section that explains *why*; a runnable example; finish with a link to the full reference.
- **Don'ts**: announcements with nothing to explain; "We're excited to announce".
- **Example**: "Giving an AI app your inbox is a real decision. This post explains what you choose when you connect one, what we chose for you, and why."

#### Changelog
- **Do's**: a bold feature name, one sentence on what changed, and a link to the docs.
- **Don'ts**: version-number noise, "various improvements".
- **Example**: "**Plans.** Free, Pro at $6 and Team at $12 per person a month. Shared mailboxes are free."

#### In-app UI and errors
- **Do's**: start buttons with a verb ("Start free", "Disconnect"); errors say what happened, why and how to fix it; confirmations name the action ("Delete 3 files?").
- **Don'ts**: "Submit", "OK/Cancel", "Are you sure?", toasts in the mobile app.

#### Security, Privacy and Terms
- **Do's**: "This page describes what xstate actually does"; date at the top; list of changes at the end; exact mechanisms.
- **Don'ts**: any claim about a control that isn't built (see Open Questions).

#### Cold outreach and social media (inferred, no samples yet)
- **Overall tone**: the founder speaking in the first person, the same plain voice, a little warmer.
- **Do's**: one specific detail ("sending is off by default for every AI app"), one link.
- **Don'ts**: hashtags in bulk, emoji as punctuation, "DM me".
- **Example**: "We built xstate so Claude can draft your replies without being able to send them. Sending stays off until you turn it on."

---

## Terminology Guide (Confidence: Medium)

### Must-Use Terms
| Term | Usage | Instead Of | Example |
|------|-------|------------|---------|
| **xstate** | Always lowercase, even at the start of a sentence | Xstate, XState, xState | "xstate runs an MCP server…" |
| **person / people** | For pricing and seats | user, seat | "$6 per person a month" |
| **AI app** | An outside app connected over MCP (Claude, Codex, Cursor, ChatGPT) | agent, integration, bot | "Connect an AI app" |
| **agent** | Only an agent built and run inside xstate on the customer's own AI key (and generic "agents" as machine readers of the site) | for apps connected over MCP | "10 agents, 500 runs per person a month" |
| **mailbox** | An inbox that people or AI apps can be given access to | account, inbox (in settings) | "Only the mailboxes you pick" |
| **address** | What people send mail to (`hello@`) | alias (unless it is one) | "Create addresses" |
| **organization**, **owner**, **admin**, **member** | Roles, exactly as in the app | workspace, team admin | "Owners and admins see every app" |
| **Draft only / Draft and send / Read only** | Permission names, bold, as in the app | "write access" | "Starts on **Draft only**" |
| **Storage** | The files product, capitalized | Drive, Files app | "files in Storage" |
| **personal token** | API credential | API key (that is a different thing) | "create a personal token" |

### Preferred Terms
| Term | Usage | Example |
|------|-------|---------|
| your own domain / a domain you own | Ownership framing | "on a domain you own" |
| choose / pick / tick | For permissions | "only the permissions you tick" |
| disconnect / take access back | For revoking | "Taking access back" |
| Start free | Main sign-up button | (header, hero, pricing) |
| Settings → X → Y | Paths in the UI | "**Settings → Connected apps**" |

### Avoid These Terms
| Term | Reason | Alternative |
|------|--------|-------------|
| user | Pricing and copy now say "person" | person, you |
| seamless, powerful, robust | Empty adjectives | the fact that shows it |
| leverage, utilize, solution | Corporate | use, product name |
| Get started / Sign up / Connect a domain (as main button) | Inconsistent labels | Start free |
| forever, unlimited (without a qualifier) | Promises we may not keep | no card needed; "unlimited, no seat charge" with its scope |
| tool calls | Jargon for buyers | actions |
| Your Digital Real Estate | Needs explaining; says nothing in search results | the value proposition |

### Never-Use Terms
| Term | Reason |
|------|--------|
| "end-to-end encrypted", "military-grade", "unhackable" | Not true or not provable; damages trust in the Security page |
| "We're excited to announce" | Hype; say what changed |
| Claims that a feature is live when it is "coming" or "rolling out" | Breaks the honesty principle |

### Mechanics (house style)
- Sentence case for headings and buttons.
- No exclamation marks.
- Contractions are fine ("don't", "isn't").
- No Oxford comma ("mail, calendar, files and contacts").
- Numbers as digits ("5 people", "30 days"). Prices as "$6 per person a month".
- Prefer colons and full stops to em dashes.
- UI labels in **bold**, paths with →, code, addresses and commands in `backticks`.
- "We" means xstate, and "you" means the reader.

---

## Content Examples

### Excellent example (on-brand)
> "With **Draft only**, an app can read your mail, write replies and save them to Drafts. You read the draft and press
> send. The app cannot send anything until you choose **Draft and send**. We made this the default because email is
> written by other people."
> — *What an AI app can do with your mail* (blog, 2026-11-16)

Why it works: the exact setting names in bold, short declarative sentences, the reader in control, and one reason
for the default.

### Example to avoid (and the fix)
> Before: "Point a domain at xstate and get a working inbox in minutes. Connect Claude, Codex or Cursor to it with
> scoped permissions. Everything you own stays on a domain you control."
> — old homepage subhead (replaced 2026-11-17)

What's wrong: "scoped permissions" is jargon. "Own… control" says the same thing twice and overclaims, because the
data lives on xstate's servers, not on the domain.
Fix: "Email, calendar and files for your team, free for up to 5 people. Connect Claude, Codex or Cursor and choose
exactly what each one may read, draft or send."

---

## Confidence Scores

| Section | Confidence | Basis | Sources |
|---------|------------|-------|---------|
| Voice Attributes | Medium | Consistent in all published content; no prior style guide | 12 |
| Messaging Framework | Medium | Consistent in homepage, docs and blog; not checked against sales conversations | 6 |
| Tone Matrix | Medium / Low | Published contexts have 3+ examples each; outreach and social are inferred | 12 |
| Terminology | Medium | Consistent usage; agent vs AI app settled 2026-11-17 | 10 |
| Language Patterns | n/a | No call transcripts; section omitted | 0 |

**Aggregate:** 0.60 (Medium). Language Patterns are excluded and the other weights rescaled. Confirming the open
questions below and adding a few sales or support emails would raise this to High.

---

## Open Questions for Team Discussion

### Resolved
1. **"Agent" or "AI app"?** Decided 2026-11-17: **AI app** = an outside app connected over MCP. **Agent** = something
   built and run inside xstate. The homepage, page titles and docs overview were updated to match.
2. **Who is the primary reader?** Decided 2026-11-17: founders and small teams who already use AI tools. Developers
   are the secondary reader, served in the docs, the blog and the footer. See "Audience" near the top.

### Medium Priority
3. **Do the legal and security pages claim more than is built?**
   - What was found: the voice is built on "only what's true today". Earlier internal notes flag that the legal docs overclaim, and that 2FA, session revocation and an audit log aren't built yet.
   - Agent recommendation: review Terms, Privacy and Security against what's live before any marketing push, and remove or date anything not built.
   - Need from you: approval to run that review.

4. **Retire "Your Digital Real Estate"?**
   - What was found: it's now only in the footer. It doesn't fit the plain-spoken voice.
   - Agent recommendation: retire it, or keep it as an internal brand idea only.
   - Need from you: keep or retire.

5. **Voice for social media and outreach**
   - What was found: no samples exist.
   - Agent recommendation: write it as the founder, in the first person, in the same voice. Base each post on one concrete product decision, like the blog does.
   - Need from you: 3–5 posts or emails you liked, to raise confidence.

### Low Priority
6. **Oxford comma**: the content currently uses none. Recommendation: keep it that way for consistency. Confirm.
7. **"xstate" at the start of a sentence**: currently lowercase everywhere. Recommendation: keep it lowercase. Confirm.

---

## Data Gaps & Recommendations

- [ ] No sales, support or outreach emails analyzed: add 5–10 sent emails to calibrate warmth and the outreach voice.
- [ ] No social posts: add a few so the social tone moves from inferred to observed.
- [ ] In-app copy (apps/app, apps/mobile) not analyzed: a pass would confirm the error and empty-state patterns.
- [ ] No customer feedback or transcripts: add these to check that the message pillars match how customers describe xstate.

---

## Appendix: Sources

| # | Source | Platform | Type | Date | Key Sections Used | Confidence |
|---|--------|----------|------|------|-------------------|------------|
| 1 | Homepage (hero, features, FAQ, CTA) | apps/web/app/(marketing)/page.tsx, chrome.tsx | Operational | 2026-11-17 | Messaging, terminology, examples | High |
| 2 | Pricing table | apps/web/app/(marketing)/controls.tsx | Operational | 2026-11-17 | Terminology | High |
| 3 | What an AI app can do with your mail | blog/agent-permissions.md | Operational | 2026-11-16 | Voice, example, pillars | High |
| 4 | One URL, three formats | blog/content-negotiation.md | Operational | 2026-11-17 | Agent-native, explains why | High |
| 5 | Send receipts and alerts… | blog/transactional-email-api.md | Operational | 2026-11-16 | Honest limits, positioning | High |
| 6 | Domain Connect in practice (draft) | blog/domain-connect.md | Draft | 2026-09-30 | Honesty (held until facts exist) | Low |
| 7 | Changelog 2026-11-10 and 2026-11-16 | content/changelog | Operational | 2026-11 | Changelog tone | Medium |
| 8 | Docs overview | docs/index.md | Operational | 2026-11 | Value proposition | High |
| 9 | Quickstart | docs/quickstart.md | Operational | 2026-11 | Docs tone | High |
| 10 | Connect AI apps | docs/mcp.md | Operational | 2026-11 | Terminology, control | High |
| 11 | Security | docs/security.md | Operational | 2026-11-16 | Specificity | High |
| 12 | Privacy | docs/privacy.md | Legal | 2026-11 | AI-training claim | Medium |
