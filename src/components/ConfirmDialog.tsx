import React from 'react';

/**
 * In-app replacement for `window.confirm`.
 *
 * Why this exists rather than just calling `window.confirm`: in Electron the
 * native dialog runs a nested modal loop that blocks the renderer entirely, and
 * when it closes keyboard focus is not reliably handed back to the page. The
 * observable result was a window that froze while the prompt was up and, after
 * dismissing it, text inputs that silently refused to accept typing — reported
 * as "after I delete a subscription I can't type in the name field". Nothing in
 * React can restore that focus, because the input never lost it as far as the
 * DOM is concerned; the problem is above the page.
 *
 * A plain React overlay has neither problem: the renderer keeps running and
 * focus never leaves the document.
 */

export interface ConfirmOptions {
  title: string;
  /** Body text. Newlines are preserved. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Returns an async `confirm` plus the element to render.
 *
 * The promise-based shape keeps call sites reading like the `window.confirm`
 * they replace:
 *
 *   if (!(await confirm({ title, message }))) return;
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: React.ReactNode;
} {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    []
  );

  // Settle the promise exactly once, whichever way the dialog is dismissed —
  // button, Escape or backdrop. Leaving it unsettled would hang the caller.
  const settle = React.useCallback(
    (ok: boolean) => {
      setPending((current) => {
        current?.resolve(ok);
        return null;
      });
    },
    []
  );

  const confirmDialog = pending ? (
    <ConfirmDialog options={pending} onResolve={settle} />
  ) : null;

  return { confirm, confirmDialog };
}

function ConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmOptions;
  onResolve: (ok: boolean) => void;
}) {
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);

  // Focus the confirm button so the dialog is operable from the keyboard, and
  // let Escape cancel. Bound on document so it works regardless of what had
  // focus when the dialog opened.
  React.useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onResolve(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
      onClick={() => onResolve(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="bg-surface-800 border border-surface-700 rounded-xl w-[420px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-surface-700">
          <h3 id="confirm-dialog-title" className="text-base font-semibold text-surface-100">
            {options.title}
          </h3>
        </div>

        <div className="p-4">
          <p className="text-sm text-surface-300 whitespace-pre-line break-words">{options.message}</p>
        </div>

        <div className="p-4 border-t border-surface-700 flex justify-end gap-2">
          <button onClick={() => onResolve(false)} className="btn-secondary">
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={() => onResolve(true)}
            className={options.danger ? 'btn-primary !bg-red-600 hover:!bg-red-500' : 'btn-primary'}
          >
            {options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
