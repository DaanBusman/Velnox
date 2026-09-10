import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Layout and status primitives.
 *
 * Hand-written rather than pulled from a component library: the surface is
 * cards, tables and status badges, and a dependency that ships dozens of unused
 * components would be carried into every later licence review for no benefit.
 *
 * These now carry the elevation scale from `globals.css` rather than sitting
 * flat. A card is a raised surface: a hairline border, a contact shadow, and a
 * lit top edge. Its header sits on the recessed tone so the plane it belongs to
 * is legible without a heavy rule.
 */

export type StatusTone = 'ok' | 'warn' | 'error' | 'unknown' | 'neutral';

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** For content that has to reach the card's edge — a table, mostly. */
  bodyClassName?: string;
}) {
  return (
    <section
      className={clsx(
        'overflow-hidden rounded-md border border-line bg-surface shadow-card',
        'velnox-lit',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line bg-surface-2/60 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName ?? 'px-4 py-3.5'}>{children}</div>
    </section>
  );
}

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'bg-ok-bg text-ok ring-ok/20',
  warn: 'bg-warn-bg text-warn ring-warn/20',
  error: 'bg-error-bg text-error ring-error/20',
  unknown: 'bg-unknown-bg text-unknown ring-unknown/20',
  neutral: 'bg-surface-2 text-ink-muted ring-line',
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
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        'ring-1 ring-inset',
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
    <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-baseline gap-x-4 gap-y-1 border-b border-line/70 py-2.5 last:border-b-0">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">
      {children}
    </code>
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
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
        'rounded-md border px-4 py-3 text-sm shadow-card',
        // A colour bar down the leading edge, so the severity survives being
        // skimmed and does not rely on a wash that is deliberately subtle.
        'border-l-[3px]',
        tone === 'warn' && 'border-warn/30 border-l-warn bg-warn-bg text-ink',
        tone === 'error' && 'border-error/30 border-l-error bg-error-bg text-ink',
        tone === 'ok' && 'border-ok/30 border-l-ok bg-ok-bg text-ink',
        (tone === 'neutral' || tone === 'unknown') &&
          'border-line border-l-line-strong bg-surface text-ink',
      )}
    >
      {title && <p className="mb-1 font-semibold tracking-tight">{title}</p>}
      <div className="text-ink-muted [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2">
        {children}
      </div>
    </div>
  );
}
