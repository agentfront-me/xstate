// CSV files in a spreadsheet grid (react-data-grid). The first line is the header row. People with editor access
// can change cells, rename columns, and add or remove rows and columns; Save writes it back as CSV.
// Loaded on demand (React.lazy), so Mail doesn't pay for the grid.

import 'react-data-grid/lib/styles.css'
import Papa from 'papaparse'
import { useEffect, useMemo, useState } from 'react'
import { type Column, DataGrid, renderTextEditor, SelectColumn } from 'react-data-grid'
import { Icon } from '../../components/Icon'
import type { EditorProps } from './types'

type Row = { _id: number; cells: string[] }

/** Above this the grid opens read-only: editing means holding every cell in memory twice. */
const MAX_EDIT_BYTES = 20 * 1024 * 1024

export default function CsvEditor({ blob, editable, onChange, register }: EditorProps) {
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const tooBig = blob.size > MAX_EDIT_BYTES
  const canEdit = editable && !tooBig
  const [nextId, setNextId] = useState(0)

  useEffect(() => {
    let cancelled = false
    void blob.text().then((text) => {
      if (cancelled) return
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
      const data = parsed.data
      const width = Math.max(1, ...data.map((r) => r.length))
      const head = (data[0] ?? []).concat(Array(Math.max(0, width - (data[0]?.length ?? 0))).fill(''))
      const body = data.slice(1).map((cells, i) => ({ _id: i, cells: pad(cells, width) }))
      setHeaders(head.map((h, i) => h || `Column ${i + 1}`))
      setRows(body)
      setNextId(body.length)
      if (parsed.errors.length && !data.length) setError(parsed.errors[0]!.message)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [blob])

  // Hands the page a way to read the current contents back as CSV when it saves.
  useEffect(() => {
    register(() => new Blob([Papa.unparse([headers, ...rows.map((r) => r.cells)], { newline: '\n' }) + '\n'], { type: 'text/csv' }))
  }, [headers, rows, register])

  const change = (nextHeaders: string[], nextRows: Row[]) => {
    setHeaders(nextHeaders)
    setRows(nextRows)
    onChange()
  }

  const columns = useMemo<Column<Row>[]>(() => {
    const cols: Column<Row>[] = headers.map((name, i) => ({
      key: String(i),
      name,
      resizable: true,
      minWidth: 80,
      width: 'max-content',
      renderCell: ({ row }) => row.cells[i] ?? '',
      renderEditCell: canEdit
        ? (props) =>
            renderTextEditor({
              ...props,
              row: { ...props.row, [String(i)]: props.row.cells[i] ?? '' } as Row,
              onRowChange: (r, commit) => {
                const value = (r as unknown as Record<string, string>)[String(i)] ?? ''
                const cells = [...props.row.cells]
                cells[i] = value
                props.onRowChange({ ...props.row, cells }, commit)
              },
            })
        : undefined,
      renderHeaderCell: canEdit
        ? () => (
            <input
              className="csv-head-input"
              defaultValue={name}
              aria-label={`Column ${i + 1} name`}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const value = e.currentTarget.value
                if (value !== headers[i]) change(headers.map((h, j) => (j === i ? value : h)), rows)
              }}
            />
          )
        : undefined,
    }))
    const rowNumber: Column<Row> = {
      key: '_n',
      name: '',
      width: 48,
      frozen: true,
      cellClass: 'csv-rownum',
      renderCell: ({ rowIdx }) => rowIdx + 1,
    }
    return canEdit ? [SelectColumn, rowNumber, ...cols] : [rowNumber, ...cols]
    // change() reads the latest headers/rows through the closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, rows, canEdit])

  const addRow = () => {
    change(headers, [...rows, { _id: nextId, cells: Array(headers.length).fill('') }])
    setNextId((n) => n + 1)
  }
  const addColumn = () =>
    change([...headers, `Column ${headers.length + 1}`], rows.map((r) => ({ ...r, cells: [...r.cells, ''] })))
  const removeRows = () => {
    change(headers, rows.filter((r) => !selected.has(r._id)))
    setSelected(new Set())
  }
  const removeLastColumn = () => {
    if (headers.length <= 1) return
    change(headers.slice(0, -1), rows.map((r) => ({ ...r, cells: r.cells.slice(0, -1) })))
  }

  if (!loaded) return <div className="loading"><span className="spinner" /></div>
  if (error) return <div className="empty"><Icon name="circle-alert" size={24} /><strong>Couldn't read this CSV</strong><span>{error}</span></div>

  return (
    <div className="csv">
      <div className="viewer-bar">
        {canEdit ? (
          <>
            <button className="btn-tool" onClick={addRow}><Icon name="plus" size={14} />Row</button>
            <button className="btn-tool" onClick={addColumn}><Icon name="plus" size={14} />Column</button>
            <button className="btn-tool" onClick={removeLastColumn} disabled={headers.length <= 1} title="Remove the last column">
              <Icon name="minus" size={14} />Column
            </button>
            <button className="btn-tool" onClick={removeRows} disabled={!selected.size}>
              <Icon name="trash" size={14} />Delete {selected.size > 1 ? `${selected.size} rows` : 'row'}
            </button>
          </>
        ) : (
          <span className="muted small">{tooBig && editable ? 'Too large to edit here (over 20 MB). Download it to edit.' : 'View only'}</span>
        )}
        <span className="spacer" />
        <span className="muted small">{rows.length.toLocaleString()} rows · {headers.length} columns</span>
      </div>
      <DataGrid
        className="csv-grid"
        columns={columns}
        rows={rows}
        rowKeyGetter={(r) => r._id}
        onRowsChange={(next) => change(headers, next)}
        selectedRows={canEdit ? selected : undefined}
        onSelectedRowsChange={canEdit ? setSelected : undefined}
        defaultColumnOptions={{ resizable: true }}
        rowHeight={32}
        headerRowHeight={34}
      />
    </div>
  )
}

const pad = (cells: string[], width: number) => (cells.length >= width ? cells : cells.concat(Array(width - cells.length).fill('')))
