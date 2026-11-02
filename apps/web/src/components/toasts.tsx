import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** A button shown in the toast, typically "Annuler" right after a destructive action. */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  text: string;
  kind: "success" | "error";
  action?: ToastAction | undefined;
}

const ToastContext = createContext<(text: string, kind?: Toast["kind"], action?: ToastAction) => void>(() => undefined);

/** Toasts with an action stay longer: the reader needs time to decide. */
const DURATION_MS = 5000;
const ACTION_DURATION_MS = 10_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (text: string, kind: Toast["kind"] = "success", action?: ToastAction) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { id, text, kind, action }]);
      window.setTimeout(() => dismiss(id), action ? ACTION_DURATION_MS : DURATION_MS);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === "error" ? " error" : ""}`} role="status">
            <span>{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="btn toast-action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
