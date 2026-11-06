import { Icon, type IconName } from '../components/Icon'

export type Page = { id: string; label: string; icon: IconName }

export const PAGES: Page[] = [
  { id: 'mail', label: 'Email', icon: 'inbox' },
  { id: 'storage', label: 'Storage', icon: 'hard-drive' },
  { id: 'databases', label: 'Databases', icon: 'database' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'sites', label: 'Sites', icon: 'globe' },
]

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
