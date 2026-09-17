import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant =
  'default' | 'primary' | 'start' | 'stop' | 'warning' | 'link' | 'danger-link';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'border border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700',
  primary: 'border border-neutral-500 bg-neutral-100 text-neutral-900 hover:bg-white',
  start: 'border border-green-900/50 bg-green-950/40 text-green-200 hover:bg-green-900/40',
  stop: 'border border-red-900/50 bg-red-950/40 text-red-200 hover:bg-red-900/40',
  warning: 'border border-amber-600/60 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30',
  link: 'text-neutral-500 hover:text-neutral-200',
  'danger-link': 'text-neutral-500 hover:text-red-400',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider',
  md: 'px-3 py-1.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonProps): React.ReactElement {
  const link = variant === 'link' || variant === 'danger-link';
  const shape = link ? 'font-mono text-[10px] uppercase tracking-wider' : `rounded ${SIZES[size]}`;
  return (
    <button
      type={type}
      className={`shrink-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${shape} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
