import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Layout and status primitives.
 *
 * Hand-written for Phase 1 rather than pulled from a component library: the
 * whole Phase 1 surface is cards, tables and status badges, and a dependency
 * that ships dozens of unused components would be carried into every later
 * licence review for no benefit. Radix-based interactive primitives (dialog,
 * select, dropdown) arrive with the forms in Phase 2, where they earn their
 * weight.
 */

export type StatusTone = 'ok' | 'warn' | 'error' | 'unknown' | 'neutral';

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={clsx(
        'rounded border border-line bg-surface',
        'shadow-[0_1px_2px_rgba(16,21,28,0.04)]',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  error: 'bg-error-bg text-error',
  unknown: 'bg-unknown-bg text-unknown',
  neutral: 'bg-surface-2 text-ink-muted',
};

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-current"
        // A dot alone would carry meaning by colour only; the text beside it is
        // the actual signal, which is what keeps this readable without colour.
      />
      {children}
    </span>
  );
}

export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-baseline gap-x-4 gap-y-1 border-b border-line py-2 last:border-b-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{children}</code>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: StatusTone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'rounded border px-4 py-3 text-sm',
        tone === 'warn' && 'border-warn/40 bg-warn-bg text-ink',
        tone === 'error' && 'border-error/40 bg-error-bg text-ink',
        tone === 'ok' && 'border-ok/40 bg-ok-bg text-ink',
        (tone === 'neutral' || tone === 'unknown') && 'border-line bg-surface-2 text-ink',
      )}
    >
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-ink-muted">{children}</div>
    </div>
  );
}
