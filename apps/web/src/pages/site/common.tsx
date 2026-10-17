import { useState, type ReactNode } from "react";
import { ErrorBanner, Modal } from "../../components/ui";

/** Confirmation of an action that needs no reason; the error of the action stays in the dialog. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Retour
            </button>
            <button
              type="button"
              className={danger ? "btn btn-d" : "btn btn-p"}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onConfirm();
                  onClose();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <span className="spinner" aria-label="En cours" /> : confirmLabel}
            </button>
          </div>
        </>
      }
    >
      <div>{children}</div>
      <ErrorBanner error={error} />
    </Modal>
  );
}

/** Up and down buttons of an ordered list; the label names the element for screen readers. */
export function MoveButtons({ label, index, count, onMove }: { label: string; index: number; count: number; onMove: (to: number) => void }) {
  return (
    <span className="row center" style={{ gap: 2, flexWrap: "nowrap" }}>
      <button type="button" className="btn btn-g site-icon-btn" aria-label={`Monter ${label}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button
        type="button"
        className="btn btn-g site-icon-btn"
        aria-label={`Descendre ${label}`}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
    </span>
  );
}

/** The list with one element moved to another position. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Characters typed against the limit, in amber past the recommended length and red past the limit. */
export function CharCount({ value, recommended, max }: { value: string; recommended?: number; max: number }) {
  const n = value.trim().length;
  const color = n > max ? "#a3261b" : recommended !== undefined && n > recommended ? "#7a4a00" : undefined;
  return (
    <span className="cap" style={color ? { color } : undefined} aria-live="polite">
      {n} / {recommended ?? max} caractères
      {recommended !== undefined && n > recommended ? " (au-delà, le texte risque d'être coupé)" : ""}
    </span>
  );
}
