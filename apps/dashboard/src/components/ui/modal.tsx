import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The one modal in the app. Both the confirm dialog and the route form sit on it, so focus handling
 * and dismissal behave identically wherever a dialog appears.
 *
 * It restores focus to whatever opened it, moves focus inside on open, keeps Tab within the panel
 * and closes on Escape or a click on the backdrop.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'sm',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'lg';
}) {
  const panel = React.useRef<HTMLDivElement>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh] sm:pt-[6vh]">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-zinc-950/25 dark:bg-black/60"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'surface relative w-full p-4 shadow-xl',
          size === 'lg' ? 'max-w-lg' : 'max-w-sm',
        )}
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1 text-chrome text-zinc-600 dark:text-zinc-400">
            {description}
          </p>
        )}
        {children && <div className="mt-3">{children}</div>}
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation for an action that cannot be undone. Deleting a route and revoking a key both break
 * live traffic, so neither is a bare click any more.
 *
 * `confirmWord` turns it into a type-to-confirm: the operator has to type the resource's name. Used
 * where the damage is silent, such as revoking a key that some integration is still presenting.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  confirmWord,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  confirmWord?: string;
  pending?: boolean;
}) {
  const [typed, setTyped] = React.useState('');
  const inputId = React.useId();

  // Callers pass a key tied to the target, so a dialog opened for a different resource is a fresh
  // component and the typed value starts empty. Closing clears it for the same-target case.
  const close = () => {
    setTyped('');
    onClose();
  };

  const armed = !confirmWord || typed.trim() === confirmWord;

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!armed || pending}
            onClick={onConfirm}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {confirmWord && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-[12px] text-zinc-600 dark:text-zinc-400">
            Type <span className="font-mono text-zinc-900 dark:text-zinc-100">{confirmWord}</span> to
            confirm
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-8 rounded-md border border-zinc-950/[0.09] bg-white px-2 font-mono text-chrome text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70 dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-zinc-100"
          />
        </div>
      )}
    </Modal>
  );
}
