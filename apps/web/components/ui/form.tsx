'use client';

import clsx from 'clsx';
import { useId, type ReactNode } from 'react';

/**
 * Form primitives.
 *
 * Still hand-written, for the reason given in `primitives.tsx`: Phase 2 needs
 * text inputs, a button and an error summary, and a component library would be
 * carried into every later licence review to supply three things.
 *
 * The accessibility details here are the point of the file. A label tied to its
 * input, an error announced rather than only coloured, and a disabled state that
 * says why — these are what make a sign-in page usable by someone on a screen
 * reader, and they are exactly what gets skipped when each form invents its own.
 */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Receives the ids to wire the input to its label, hint and error. */
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-ink">
        {label}
      </label>

      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}

      {hint && (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}

      {error && (
        <p id={errorId} className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        'h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink',
        'placeholder:text-ink-muted',
        'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'aria-[invalid=true]:border-error aria-[invalid=true]:ring-error/30',
        className,
      )}
    />
  );
}

/**
 * A one-time code input.
 *
 * `inputMode="numeric"` brings up a number pad on a phone, and
 * `autoComplete="one-time-code"` lets the platform offer the code it just
 * received. Both are small, and both are the difference between typing a code
 * once and typing it three times.
 */
export function CodeInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <TextInput
      inputMode="numeric"
      autoComplete="one-time-code"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      maxLength={7}
      className={clsx('font-mono tracking-[0.3em]', className)}
      {...props}
    />
  );
}

export function Button({
  variant = 'primary',
  className,
  pending,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet';
  pending?: boolean;
}) {
  return (
    <button
      {...props}
      // Busy rather than disabled while working: a disabled control loses focus,
      // which drops a screen-reader user out of the form they just submitted.
      aria-busy={pending || undefined}
      disabled={props.disabled || pending}
      className={clsx(
        'inline-flex h-9 items-center justify-center gap-2 rounded px-3 text-sm font-medium',
        'focus:outline-none focus:ring-2 focus:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-accent text-accent-contrast hover:bg-accent/90',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'quiet' && 'text-ink-muted hover:text-ink',
        className,
      )}
    >
      {pending && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

/**
 * The form-level error.
 *
 * `role="alert"` so it is announced when it appears — a message that is only
 * visible is invisible to the people most likely to be retyping a password.
 */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded border border-error/40 bg-error-bg px-3 py-2 text-sm text-ink"
    >
      {children}
    </div>
  );
}
