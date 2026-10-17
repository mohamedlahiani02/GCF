import { cloneElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";
import { useFormat } from "../lib/format";
import { useI18n } from "../i18n/i18n";

export type Tone = "green" | "red" | "amber" | "blue" | "violet" | "gray" | "neutral";

/** A status is never shown by colour alone: the badge always carries its text. */
export function Badge({ tone, children, strike }: { tone: Tone; children: ReactNode; strike?: boolean | undefined }) {
  return <span className={`b b-${tone}${strike ? " b-strike" : ""}`}>{children}</span>;
}

export function Money({ value, strong }: { value: number; strong?: boolean }) {
  const { money } = useFormat();
  return <span className="num">{strong ? <strong>{money(value)}</strong> : money(value)}</span>;
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

export function Card({ title, actions, children, footer }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="card">
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

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card kpi">
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

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="card">
      <div className="card-b stack" aria-busy="true">
        <span className="skel" style={{ width: "60%" }} />
        <span className="skel" />
        <span className="skel" style={{ width: "80%" }} />
        <span className="cap">{t.common.loading}</span>
      </div>
    </div>
  );
}

export function ErrorBanner({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t, language } = useI18n();
  if (!error) return null;
  return (
    <div className="ban ban-red" role="alert">
      <strong>{t.common.error}</strong>
      <span>{errorMessage(error, language)}</span>
      {retry ? (
        <button type="button" className="btn" onClick={retry}>
          {t.common.retry}
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "green" | "blue" | "amber"; children: ReactNode }) {
  return (
    <div className={`ban ban-${tone}`} role="status">
      <span>{children}</span>
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

export function Spinner() {
  const { t } = useI18n();
  return <span className="spinner" role="status" aria-label={t.common.working} />;
}

/** A labelled form control; the hint is announced as its description, not as part of its name. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  hint?: string | undefined;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="lab" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, ...(hint ? { "aria-describedby": hintId } : {}) })}
      {hint ? (
        <span id={hintId} className="cap">
          {hint}
        </span>
      ) : null}
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

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("textarea, input, button")?.focus();
  }, []);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="card-h">
          <h2 id={titleId} className="h2">
            {title}
          </h2>
        </div>
        <div className="card-b stack">{children}</div>
        {footer ? <div className="card-f">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Pagination({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (p: number) => void }) {
  const { t } = useI18n();
  return (
    <>
      <span className="cap">{t.common.page(page)}</span>
      <div className="row center" style={{ gap: 6 }}>
        <button type="button" className="btn" aria-label={t.common.previousPage} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹
        </button>
        <span className="btn btn-p" aria-current="page">
          {page}
        </span>
        <button type="button" className="btn" aria-label={t.common.nextPage} disabled={!hasMore} onClick={() => onPage(page + 1)}>
          ›
        </button>
      </div>
    </>
  );
}

/** Label and value pairs, two columns on wide screens. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="lab">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One entry of Facts, present only when the condition holds (an optional field of the API). */
export const fact = (condition: unknown, label: string, value: ReactNode): [string, ReactNode][] => (condition ? [[label, value]] : []);
