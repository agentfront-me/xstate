import { Icon, type IconName } from '../components/Icon'

export type Page = { id: string; label: string; icon: IconName; hidden?: boolean }

const ALL_PAGES: Page[] = [
  { id: 'mail', label: 'Email', icon: 'inbox' },
  { id: 'storage', label: 'Storage', icon: 'hard-drive' },
  // Hidden for now: not in the rail, and their links go to Email. Remove `hidden` to bring them back.
  { id: 'databases', label: 'Databases', icon: 'database', hidden: true },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'sites', label: 'Sites', icon: 'globe', hidden: true },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
]

/** Pages with their own route; the rest go to the "coming soon" page. */
export const ROUTED = new Set(['mail', 'storage', 'users', 'calendar'])

/** The pages in the rail. */
export const PAGES: Page[] = ALL_PAGES.filter((p) => !p.hidden)

export function SoonPage({ page }: { page: Page }) {
  return (
    <section className="soon">
      <div className="col-head drag">
        <span className="title">{page.label}</span>
      </div>
      <div className="empty">
        <Icon name={page.icon} size={28} />
        <strong>{page.label} is coming soon</strong>
        <span>Email and Settings are ready to use today.</span>
      </div>
    </section>
  )
}
