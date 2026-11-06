import { Icon, type IconName } from '../components/Icon'
import { fileKind } from './api'

export function FileIcon({ name, contentType, kind, bare }: { name: string; contentType: string | null; kind: 'folder' | 'file'; bare?: boolean }) {
  const k = fileKind(name, contentType, kind)
  const icon: IconName = k === 'folder' ? 'folder' : k === 'csv' ? 'file-spreadsheet' : k === 'image' ? 'image' : k === 'other' ? 'file' : 'file-text'
  return <span className={`file-icon${bare ? ' is-bare' : ''}`}><Icon name={icon} size={bare ? 18 : 16} /></span>
}
