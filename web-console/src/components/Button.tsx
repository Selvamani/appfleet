import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cx } from '../lib/cx';
import s from './Button.module.css';

type Variant = 'default' | 'primary' | 'quiet' | 'danger';
type Size = 'md' | 'sm';

function classes(variant: Variant, size: Size, pressed?: boolean) {
  return cx(s.btn, variant !== 'default' && s[variant], size === 'sm' && s.sm, pressed && s.on);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Renders aria-pressed and the "on" look: use for toggle and filter buttons. */
  pressed?: boolean;
  busy?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'default', size = 'md', pressed, busy, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(classes(variant, size, pressed), className)}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps {
  variant?: Variant;
  size?: Size;
}

/** A link that looks like a button. Stays an <a>, because it navigates. */
export function ButtonLink({ variant = 'default', size = 'md', className, ...rest }: ButtonLinkProps) {
  return <Link className={cx(classes(variant, size), className)} {...rest} />;
}
