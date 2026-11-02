import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Modal } from "../../components/ui";

/** Apple keyboards say Cmd where the others say Ctrl. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "Cmd" : "Ctrl";
export const MOD_KEY = MOD;

type Combo = string[];
interface Shortcut {
  action: string;
  combos: Combo[];
}

const KEYBOARD: Shortcut[] = [
  { action: "Copier", combos: [[MOD, "C"]] },
  { action: "Couper", combos: [[MOD, "X"]] },
  { action: "Coller (de nouvelles places sont créées)", combos: [[MOD, "V"]] },
  { action: "Dupliquer", combos: [[MOD, "D"]] },
  { action: "Tout sélectionner", combos: [[MOD, "A"]] },
  { action: "Annuler la dernière action", combos: [[MOD, "Z"]] },
  {
    action: "Rétablir",
    combos: [
      [MOD, "Y"],
      [MOD, "Maj", "Z"],
    ],
  },
  { action: "Retirer du plan", combos: [["Suppr"], ["Effacer"]] },
  { action: "Déplacer un peu", combos: [["Flèches"]] },
  { action: "Déplacer davantage", combos: [["Maj", "Flèches"]] },
  { action: "Pivoter de 15 degrés", combos: [["R"]] },
  { action: "Pivoter d'un quart de tour", combos: [["Maj", "R"]] },
  { action: "Tout désélectionner", combos: [["Échap"]] },
  { action: "Agrandir ou réduire le plan", combos: [["+"], ["-"]] },
  { action: "Afficher cette aide", combos: [["?"]] },
];

const MOUSE: Shortcut[] = [
  { action: "Déplacer un élément", combos: [["Glisser"]] },
  { action: "Ajouter ou retirer de la sélection", combos: [["Maj", "Clic"]] },
  { action: "Sélectionner une partie du plan", combos: [["Glisser sur le vide"]] },
  { action: "Renommer", combos: [["Double-clic"]] },
  { action: "Menu des actions", combos: [["Clic droit"]] },
  { action: "Agrandir ou réduire le plan", combos: [[MOD, "Molette"]] },
  { action: "Se déplacer dans le plan", combos: [["Espace", "Glisser"], ["Bouton du milieu"]] },
];

function KeyCaps({ combos }: { combos: Combo[] }) {
  return (
    <span className="fpe-keys">
      {combos.map((combo, i) => (
        <Fragment key={i}>
          {i ? <span className="cap"> ou </span> : null}
          {combo.map((key, j) => (
            <Fragment key={j}>
              {j ? <span aria-hidden="true">+</span> : null}
              <kbd>{key}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function ShortcutList({ title, list }: { title: string; list: Shortcut[] }) {
  return (
    <section className="stack" style={{ gap: 8 }}>
      <h3 className="h2">{title}</h3>
      <dl className="fpe-shortcuts">
        {list.map((s) => (
          <div key={s.action}>
            <dt>{s.action}</dt>
            <dd>
              <KeyCaps combos={s.combos} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Every shortcut and mouse gesture of the editor, opened by the Aide button or the "?" key. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Aide : raccourcis et gestes"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cap">Tout est aussi possible à la souris, avec les boutons de l'éditeur ou le clic droit.</span>
          <button type="button" className="btn btn-p" onClick={onClose}>
            Fermer
          </button>
        </>
      }
    >
      <div className="fpe-help-grid">
        <ShortcutList title="Au clavier" list={KEYBOARD} />
        <ShortcutList title="À la souris" list={MOUSE} />
      </div>
    </Modal>
  );
}

export interface MenuEntry {
  label: string;
  keys?: Combo | undefined;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  run: () => void;
}

/** Right-click menu of the plan, kept inside the window; arrows move between entries, Escape closes it. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  return (
    <div ref={ref} className="fpe-menu" role="menu" style={position} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((entry) => (
        <button
          key={entry.label}
          type="button"
          role="menuitem"
          className={entry.danger ? "danger" : undefined}
          disabled={entry.disabled}
          onClick={() => {
            onClose();
            entry.run();
          }}
        >
          <span>{entry.label}</span>
          {entry.keys ? <KeyCaps combos={[entry.keys]} /> : null}
        </button>
      ))}
    </div>
  );
}

export interface TourStep {
  target: () => Element | null;
  title: string;
  text: string;
}

const TOUR_KEY = "gcf.planEditor.tourDone";

/** The tour shows once per browser; storage can be unavailable (private mode), in which case it shows each time. */
export function tourWanted(): boolean {
  try {
    return window.localStorage.getItem(TOUR_KEY) !== "1";
  } catch {
    return true;
  }
}

function rememberTour() {
  try {
    window.localStorage.setItem(TOUR_KEY, "1");
  } catch {
    // Storage blocked (private browsing): the tour shows again next time, nothing else depends on it.
  }
}

/** First-visit guided tour: each step outlines a part of the editor and explains it in one sentence. */
export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[index]!;
  useLayoutEffect(() => {
    const measure = () => setRect(step.target()?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    cardRef.current?.querySelector<HTMLButtonElement>(".btn-p")?.focus();
    return () => window.removeEventListener("resize", measure);
  }, [step]);
  const finish = () => {
    rememberTour();
    onDone();
  };
  const cardWidth = 340;
  const place = (() => {
    if (!rect) return { left: window.innerWidth / 2 - cardWidth / 2, top: window.innerHeight / 3 };
    if (rect.right + cardWidth + 24 < window.innerWidth) return { left: rect.right + 16, top: Math.max(16, Math.min(rect.top + 16, window.innerHeight - 260)) };
    if (rect.bottom + 220 < window.innerHeight)
      return { left: Math.max(16, Math.min(rect.right - cardWidth, window.innerWidth - cardWidth - 16)), top: rect.bottom + 16 };
    return { left: Math.max(16, rect.left + rect.width / 2 - cardWidth / 2), top: Math.max(16, rect.top + rect.height / 2 - 100) };
  })();
  return (
    <div className="fpe-tour" role="dialog" aria-modal="true" aria-label={`Visite guidée, étape ${index + 1} sur ${steps.length}`}>
      {rect ? <div className="fpe-tour-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} /> : null}
      <div
        ref={cardRef}
        className="fpe-tour-card card"
        style={{ ...place, width: cardWidth }}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish();
        }}
      >
        <span className="cap">
          Étape {index + 1} sur {steps.length}
        </span>
        <h2 className="h2">{step.title}</h2>
        <p>{step.text}</p>
        <div className="row between center" style={{ gap: 8 }}>
          <button type="button" className="btn btn-g" onClick={finish}>
            Passer la visite
          </button>
          <button type="button" className="btn btn-p" onClick={() => (index + 1 < steps.length ? setIndex(index + 1) : finish())}>
            {index + 1 < steps.length ? "Suivant" : "C'est compris"}
          </button>
        </div>
      </div>
    </div>
  );
}
