import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { PRIORITY, type ActionNotice, type useActionQueue } from "../lib/action-queue";
import { NavIcon } from "./nav-icon";
import { newActionNotices, snapshotOf, type NoticeSnapshot } from "../lib/notification-events";

export function ActionNotices({ items, onNavigate }: { items: ActionNotice[]; onNavigate?: () => void }) {
  return (
    <ul className="action-notices">
      {items.map((item) => (
        <li key={item.id} className={`notice-${item.priority}`}>
          <span className="notice-mark" aria-hidden="true">
            {item.priority === "urgent" ? "!" : item.priority === "attention" ? "✓" : "i"}
          </span>
          <div className="notice-body">
            <span className="notice-priority">{PRIORITY[item.priority]}</span>
            <strong>{item.title}</strong>
            <p>{item.text}</p>
            <Link to={item.to} onClick={onNavigate}>
              {item.action}
            </Link>
          </div>
          <span className="notice-quantity">
            {item.count}
            {item.more ? "+" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NotificationBell({ queue }: { queue: ReturnType<typeof useActionQueue> }) {
  const [open, setOpen] = useState(false);
  const [incoming, setIncoming] = useState<ActionNotice | null>(null);
  const [pending, setPending] = useState<ActionNotice | null>(null);
  const [hasNew, setHasNew] = useState(false);
  const [paused, setPaused] = useState(false);
  const previous = useRef<NoticeSnapshot | null>(null);
  const signature = JSON.stringify(queue.items);
  const urgent = queue.items.some((item) => item.priority === "urgent");
  useEffect(() => {
    if (queue.busy || queue.error) return;
    const items = JSON.parse(signature) as ActionNotice[];
    const arrivals = newActionNotices(previous.current, items);
    previous.current = snapshotOf(items);
    if (arrivals.length && !open) {
      setHasNew(true);
      const next = arrivals[0]!;
      setPending((old) => (old?.priority === "urgent" && next.priority !== "urgent" ? old : next));
    }
  }, [signature, queue.busy, queue.error, open]);
  useEffect(() => {
    if (!pending || open) return;
    const deliver = () => {
      if (incoming?.priority === "urgent" && pending.priority !== "urgent") return;
      if (document.visibilityState !== "visible" || document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      setIncoming(pending);
      setPending(null);
      setPaused(false);
    };
    deliver();
    const timer = window.setInterval(deliver, 1000);
    return () => window.clearInterval(timer);
  }, [pending, open, incoming?.priority]);
  useEffect(() => {
    if (!incoming) return;
    const deferDuringDialog = () => {
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) {
        setPending(incoming);
        setIncoming(null);
      }
    };
    const observer = new MutationObserver(deferDuringDialog);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-modal"] });
    const timer = !paused ? window.setTimeout(() => setIncoming(null), 12_000) : undefined;
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [incoming, paused]);
  const dismissIncoming = () => {
    setIncoming(null);
    setPending(null);
  };
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="notification-wrap" ref={root}>
      <button
        type="button"
        className={`btn notification-trigger${urgent ? " has-urgent" : ""}${hasNew ? " has-new" : ""}`}
        ref={trigger}
        aria-label={`Notifications : ${queue.total}${queue.more ? " ou plus" : ""} ${queue.total === 1 ? "action en attente" : "actions en attente"}`}
        title="Notifications"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setOpen(!open);
          setHasNew(false);
          dismissIncoming();
        }}
      >
        <NavIcon d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        {queue.total ? (
          <span className="notification-count">
            {queue.total > 99 ? "99+" : queue.total}
            {queue.more && queue.total <= 99 ? "+" : ""}
          </span>
        ) : null}
        {queue.error ? (
          <span className="notification-error" aria-label="Certaines notifications sont indisponibles">
            !
          </span>
        ) : null}
      </button>
      {incoming ? (
        <section
          className={`incoming-notice notice-${incoming.priority}`}
          role="status"
          aria-live="polite"
          aria-label="Nouvelle notification"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
          }}
        >
          <span className="notice-mark" aria-hidden="true">
            {incoming.priority === "urgent" ? "!" : "i"}
          </span>
          <div className="notice-body">
            <span className="notice-priority">{incoming.priority === "urgent" ? "Nouvelle urgence" : "Nouvelle action à traiter"}</span>
            <strong>{incoming.title}</strong>
            <p>{incoming.text}</p>
            <Link to={incoming.to} onClick={dismissIncoming}>
              {incoming.action}
            </Link>
          </div>
          <button type="button" className="btn btn-g" aria-label="Fermer l’alerte" onClick={dismissIncoming}>
            ×
          </button>
        </section>
      ) : null}
      {open ? (
        <section id={id} className="notification-panel" aria-label="Notifications">
          <header>
            <div>
              <h2>Notifications</h2>
              <p>Classées par priorité, actualisées automatiquement.</p>
            </div>
            <button
              type="button"
              className="btn btn-g"
              aria-label="Fermer les notifications"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              ×
            </button>
          </header>
          {queue.busy ? (
            <p className="notification-status" role="status">
              Actualisation des notifications…
            </p>
          ) : null}
          {queue.error ? (
            <div className="notification-status" role="alert">
              Certaines notifications ne sont pas disponibles.{" "}
              <button type="button" className="btn btn-g" onClick={() => void queue.refresh()}>
                Réessayer
              </button>
            </div>
          ) : null}
          {queue.items.length ? (
            <ActionNotices items={queue.items} onNavigate={() => setOpen(false)} />
          ) : !queue.busy && !queue.error ? (
            <p className="notification-status">Tout est à jour. Aucune action en attente.</p>
          ) : null}
          <footer>
            <Link to="/tableau-de-bord" onClick={() => setOpen(false)}>
              Voir le tableau de bord
            </Link>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
