import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ATTENDANCE, INSTALLMENT_STATE, type Tone } from "../lib/labels";
import { errorMessage, type ConflictItem } from "../lib/errors";
import { frDateTime, tnd, weekdayLabel } from "../lib/format";

export function Badge({ tone, children, strike }: { tone: Tone; children: ReactNode; strike?: boolean | undefined }) {
  return <span className={`b b-${tone}${strike ? " b-strike" : ""}`}>{children}</span>;
}

export function StateBadge({ state }: { state: string }) {
  const s = INSTALLMENT_STATE[state] ?? { label: state, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone} strike={s.strike}>
      {s.label}
    </Badge>
  );
}

export function AttendanceBadge({ status, short }: { status: string; short?: boolean }) {
  const a = ATTENDANCE[status];
  if (!a) return null;
  return <Badge tone={a.tone}>{short ? a.short : a.label}</Badge>;
}

export function Money({ value, unit = true, strong }: { value: number | null | undefined; unit?: boolean; strong?: boolean }) {
  const text = `${tnd(value)}${unit && value !== null && value !== undefined ? " TND" : ""}`;
  return <span className="num">{strong ? <strong>{text}</strong> : text}</span>;
}

export function PageHeader({ title, actions, subtitle }: { title: string; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="row between center">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle ? <div className="cap">{subtitle}</div> : null}
      </div>
      {actions ? (
        <div className="row center" style={{ gap: 8 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  footer,
  style,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="card" style={style}>
      {title || actions ? (
        <div className="card-h">
          {typeof title === "string" ? <h2 className="h2">{title}</h2> : title}
          {actions ? (
            <div className="row center" style={{ gap: 8 }}>
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
      {footer ? <div className="card-f">{footer}</div> : null}
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "amber" | "red" | undefined }) {
  const style =
    tone === "amber" ? { background: "#FDF0D2", borderColor: "#EBCB86" } : tone === "red" ? { background: "#FBE4E1", borderColor: "#E7A59D" } : undefined;
  return (
    <div className="card kpi" style={style}>
      <div className="lab">{label}</div>
      <div className="amt" style={{ marginTop: 4 }}>
        {value}
      </div>
      {sub ? (
        <div className="cap" style={{ marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return (
    <div className="card">
      <div className="card-b stack" aria-busy="true">
        <span className="skel" style={{ width: "60%" }} />
        <span className="skel" />
        <span className="skel" style={{ width: "80%" }} />
        <span className="cap">{label}</span>
      </div>
    </div>
  );
}

export function ErrorBanner({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="ban ban-red" role="alert">
      <strong>Erreur</strong>
      <span>{errorMessage(error)}</span>
      {retry ? (
        <button type="button" className="btn" onClick={retry}>
          Réessayer
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong style={{ color: "var(--ink)" }}>{title}</strong>
      {text ? <span>{text}</span> : null}
      {action}
    </div>
  );
}

export function ConflictBanner({ conflicts }: { conflicts: ConflictItem[] }) {
  if (!conflicts.length) return null;
  const TYPE = { room: "Salle occupée", instructor: "Intervenant déjà pris", group: "Groupe déjà en séance" };
  return (
    <div className="ban ban-red" role="alert" style={{ flexDirection: "column", alignItems: "flex-start" }}>
      <strong>Conflit de planning</strong>
      <ul>
        {conflicts.map((c, i) => (
          <li key={i}>
            {TYPE[c.type]} :{" "}
            {c.weekday
              ? `${weekdayLabel(c.weekday)} ${c.startTime}-${c.endTime}${c.groupName ? `, ${c.groupName}` : ""}`
              : `${c.startsAt ? frDateTime(c.startsAt) : ""}${c.description ? `, ${c.description}` : ""}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Field({ label, children, error, hint }: { label: string; children: ReactNode; error?: string | null | undefined; hint?: string }) {
  return (
    <label className="field">
      <span className="lab">{label}</span>
      {children}
      {hint ? <span className="cap">{hint}</span> : null}
      {error ? <span className="err-text">{error}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="btn" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" className="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-h">
          <h2 className="h2">{title}</h2>
          <button type="button" className="btn btn-g" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? (
          <div className="card-f" style={{ flexWrap: "wrap" }}>
            {footer}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-h">
          <h3 className="h2">{title}</h3>
        </div>
        <div className="card-b stack">{children}</div>
        {footer ? <div className="card-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Confirmation of a sensitive action: the reason is mandatory and recorded in the audit log. */
export function ReasonDialog({
  title,
  explanation,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  extra,
}: {
  title: string;
  explanation: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
  extra?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Action tracée au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Retour
            </button>
            <button
              type="button"
              className={danger ? "btn btn-d" : "btn btn-p"}
              disabled={!reason.trim() || busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onConfirm(reason.trim());
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
      <div>{explanation}</div>
      {extra}
      <label className="field" htmlFor={id}>
        <span className="lab">Motif (obligatoire)</span>
        <textarea id={id} ref={ref} className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ErrorBanner error={error} />
    </Modal>
  );
}

export function Pagination({
  page,
  hasMore,
  onPage,
  total,
  pageSize,
}: {
  page: number;
  hasMore: boolean;
  onPage: (p: number) => void;
  total?: number;
  pageSize?: number;
}) {
  return (
    <>
      <span className="cap">
        {total !== undefined && pageSize ? `${Math.min(total, (page - 1) * pageSize + 1)} à ${Math.min(total, page * pageSize)} sur ${total}` : `Page ${page}`}
      </span>
      <div className="row center" style={{ gap: 6 }}>
        <button type="button" className="btn" aria-label="Page précédente" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹
        </button>
        <span className="btn btn-p" aria-current="page">
          {page}
        </span>
        <button type="button" className="btn" aria-label="Page suivante" disabled={!hasMore} onClick={() => onPage(page + 1)}>
          ›
        </button>
      </div>
    </>
  );
}

export function Bar({ value, tone }: { value: number; tone?: "g" | "a" | "r" | undefined }) {
  return (
    <div className={`bar${tone ? ` ${tone}` : ""}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function rateTone(basisPoints: number | null | undefined): "g" | "a" | "r" | undefined {
  if (basisPoints === null || basisPoints === undefined) return undefined;
  if (basisPoints >= 8500) return "g";
  if (basisPoints >= 6000) return "a";
  return "r";
}
