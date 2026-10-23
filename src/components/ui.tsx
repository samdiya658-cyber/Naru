import type { ButtonHTMLAttributes, ReactNode } from 'react';
type BtnProps = { children?: ReactNode; size?: 'sm' | 'md'; variant?: string } & ButtonHTMLAttributes<HTMLButtonElement>;
export function Btn({ children, size = 'md', variant: _v, ...rest }: BtnProps) { return <button type="button" className={'btn btn--' + size} {...rest}>{children}</button>; }
const ICONS: Record<string, string> = { copy: 'M9 9h10v10H9zM5 5h10v2H7v8H5z' };
export function IconBtn({ name, title, onClick, disabled }: { name: string; title: string; onClick?: () => void; disabled?: boolean; active?: boolean; size?: number }) {
  return <button type="button" className="icon-btn" title={title} aria-label={title} onClick={onClick} disabled={disabled}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? ICONS.copy} fill="currentColor" /></svg></button>;
}
