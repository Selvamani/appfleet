import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../lib/cx';
import s from './Layout.module.css';

export function Pill({ children, mono, title }: { children: ReactNode; mono?: boolean; title?: string }) {
  return <span className={cx(s.pill, mono && s.mono)} title={title}>{children}</span>;
}

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHeader({ title, subtitle, crumbs, actions, status }: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** Shown next to the title, for example a StatusChip. */
  status?: ReactNode;
}) {
  return (
    <header className={s.head}>
      <div className={s.headText}>
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className={s.crumbs}>
              {crumbs.map((c, i) => (
                <li key={i}>{c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}</li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className={s.h1}>{title}{status && <> {status}</>}</h1>
        {subtitle && <p className={s.sub}>{subtitle}</p>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </header>
  );
}

export function Card({ title, titleId, aside, children, className, as: Tag = 'section' }: {
  title?: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'aside';
}) {
  return (
    <Tag className={cx(s.card, className)} aria-labelledby={title && titleId ? titleId : undefined}>
      {(title || aside) && (
        <div className={s.cardHead}>
          {title && <h2 className={s.h2} id={titleId}>{title}</h2>}
          {aside && <div className={s.aside}>{aside}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

type ColumnsLayout = 'two' | 'split' | 'three' | 'tiles' | 'pair';

/**
 * Responsive column layouts.
 * two: main + side (stacks under 860px). split: narrow list + detail. three/tiles: auto-fit grids.
 * pair: one column until 1800px (Full HD), then side by side; `ratio` sets the split there.
 */
export function Columns({ layout, ratio, children, className }: {
  layout: ColumnsLayout;
  ratio?: string;
  children: ReactNode;
  className?: string;
}) {
  const style = ratio ? ({ '--pair': ratio } as CSSProperties) : undefined;
  return <div className={cx(s[layout], className)} style={style}>{children}</div>;
}

export function Stack({ children, gap = 'm', className }: { children: ReactNode; gap?: 's' | 'm' | 'l'; className?: string }) {
  return <div className={cx(s.stack, s[`gap-${gap}`], className)}>{children}</div>;
}

export function Row({ children, className, justify }: { children: ReactNode; className?: string; justify?: 'between' | 'end' }) {
  return <div className={cx(s.row, justify && s[`justify-${justify}`], className)}>{children}</div>;
}

export function Muted({ children, as: Tag = 'span' }: { children: ReactNode; as?: 'span' | 'p' | 'div' }) {
  return <Tag className={s.muted}>{children}</Tag>;
}
