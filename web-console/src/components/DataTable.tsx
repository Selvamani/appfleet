import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import s from './DataTable.module.css';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** A CSS grid track, for example 'minmax(120px, 1fr)'. Prefer minmax with fr so wide screens share space. */
  width: string;
  render: (row: T) => ReactNode;
  align?: 'start' | 'end';
}

export interface DataTableProps<T> {
  /** Accessible name for the table or list. */
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Rows narrower than this scroll sideways inside the card instead of squashing columns. */
  minWidth?: number;
  emptyText?: ReactNode;
  /**
   * Makes every row one button with aria-pressed, for list + detail screens. The rows then render as a
   * list of buttons instead of a table, because a button cannot sit between a table row and its cells.
   */
  onSelect?: (row: T) => void;
  selectedKey?: string;
}

/** Grid-based table: table semantics for screen readers, CSS grid tracks for layout. */
export function DataTable<T>({ label, columns, rows, rowKey, minWidth = 640, emptyText = 'Nothing to show.', onSelect, selectedKey }: DataTableProps<T>) {
  const style = { '--cols': columns.map(c => c.width).join(' '), '--minw': `${minWidth}px` } as CSSProperties;
  const headerCells = columns.map(c => (
    <div role={onSelect ? undefined : 'columnheader'} key={c.key} className={cx(c.align === 'end' && s.end)}>{c.header}</div>
  ));

  if (onSelect) {
    return (
      <div className={s.scroll}>
        <div className={s.table} style={style}>
          <div className={cx(s.row, s.head)} aria-hidden="true">{headerCells}</div>
          {rows.length === 0 && <p className={s.empty}>{emptyText}</p>}
          <ul className={s.list} aria-label={label}>
            {rows.map(row => {
              const key = rowKey(row);
              const selected = key === selectedKey;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={cx(s.row, s.rowButton, selected && s.selected)}
                    aria-pressed={selected}
                    onClick={() => onSelect(row)}
                  >
                    {columns.map(c => (
                      <span key={c.key} className={cx(s.cell, c.align === 'end' && s.end)}>{c.render(row)}</span>
                    ))}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className={s.scroll}>
      <div role="table" aria-label={label} className={s.table} style={style}>
        <div role="rowgroup">
          <div role="row" className={cx(s.row, s.head)}>{headerCells}</div>
        </div>
        <div role="rowgroup">
          {rows.length === 0 && (
            <div role="row" className={s.empty}><div role="cell">{emptyText}</div></div>
          )}
          {rows.map(row => (
            <div role="row" key={rowKey(row)} className={s.row}>
              {columns.map(c => (
                <div role="cell" key={c.key} className={cx(s.cell, c.align === 'end' && s.end)}>{c.render(row)}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
