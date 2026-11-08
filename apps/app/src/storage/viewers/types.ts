/** What every viewer and editor gets from the file page. */
export type EditorProps = {
  blob: Blob
  name: string
  /** The reader may change this file (editor access, and not a mail attachment). */
  editable: boolean
  /** Called on every change, so the page can show "Unsaved changes" and enable Save. */
  onChange: () => void
  /** The editor hands over a function that turns its current state into the file's bytes, for Save. */
  register: (read: () => Blob | Promise<Blob>) => void
}
