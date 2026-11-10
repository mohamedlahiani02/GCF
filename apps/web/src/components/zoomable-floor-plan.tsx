import { FloorPlanView, PLAN_WIDTH, planHeight, type FloorPlanViewProps } from "@gcf/floorplan";
import { useId, useLayoutEffect, useRef, useState } from "react";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const bounded = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
interface Frame {
  scale: number;
  width: number;
  height: number;
  left: number;
  top: number;
}
interface Drag {
  pointer: number;
  x: number;
  y: number;
  left: number;
  top: number;
  moved: boolean;
}

/** A stable viewport: 100% is the fitted overview, with zoom and pan independent of page scroll. */
export function ZoomableFloorPlan(props: FloorPlanViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef<Frame | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const wasExpanded = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const height = planHeight(props.layout, props.image);
  const fit = Math.min(size.width / PLAN_WIDTH, size.height / height);
  const scale = fit * zoom;
  const widthPx = PLAN_WIDTH * scale;
  const heightPx = height * scale;
  const canvasWidth = Math.max(size.width, widthPx);
  const canvasHeight = Math.max(size.height, heightPx);
  const left = (canvasWidth - widthPx) / 2;
  const top = (canvasHeight - heightPx) / 2;
  const panAvailable = widthPx > size.width + 1 || heightPx > size.height + 1;
  const adjust = () => setZoom(1);
  const changeZoom = (step: number) => setZoom((value) => bounded(value + step));

  useLayoutEffect(() => {
    if (!expanded) {
      if (wasExpanded.current) root.current?.querySelector<HTMLButtonElement>("[data-expand-plan]")?.focus({ preventScroll: true });
      wasExpanded.current = false;
      return;
    }
    wasExpanded.current = true;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>("[data-expand-plan]")?.focus({ preventScroll: true });
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = dialog.current;
    return () => {
      element?.close();
      document.body.style.overflow = oldOverflow;
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setSize((old) =>
        old.width === element.clientWidth && old.height === element.clientHeight ? old : { width: element.clientWidth, height: element.clientHeight },
      );
    // A new viewport (expanded/inline) always starts centred.
    previous.current = null;
    drag.current = null;
    suppressClick.current = false;
    setDragging(false);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const old = previous.current;
    if (!element) return;
    if (old && old.scale > 0 && scale > 0) {
      // Locate the centre in drawing coordinates, including the fitted plan’s margins.
      const x = (element.scrollLeft + old.width / 2 - old.left) / old.scale;
      const y = (element.scrollTop + old.height / 2 - old.top) / old.scale;
      element.scrollLeft = left + x * scale - size.width / 2;
      element.scrollTop = top + y * scale - size.height / 2;
    }
    previous.current = { scale, width: size.width, height: size.height, left, top };
  }, [scale, left, top, size.width, size.height, expanded]);

  const content = (
    <div className={`cw-plan-viewer${expanded ? " cw-plan-expanded" : ""}`}>
      <div className="cw-plan-toolbar" role="group" aria-label="Zoom du plan">
        <div className="cw-plan-zoom">
          <button type="button" className="btn" aria-label="Réduire le plan" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(-0.25)}>
            −
          </button>
          <output aria-live="polite" aria-label="Niveau de zoom">
            {Math.round(zoom * 100)} %
          </output>
          <button type="button" className="btn" aria-label="Agrandir le plan" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(0.25)}>
            +
          </button>
        </div>
        <button type="button" className="btn" onClick={adjust}>
          Vue d’ensemble
        </button>
        <button
          type="button"
          className="btn cw-plan-expand"
          data-expand-plan
          onClick={() => {
            setZoom(1);
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Fermer la vue agrandie" : "Agrandir la vue"}
        </button>
      </div>
      <div
        ref={viewport}
        className={`cw-plan-viewport${panAvailable ? " can-pan" : ""}${dragging ? " is-dragging" : ""}`}
        role="region"
        aria-label="Plan coworking avec zoom"
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={(event) => {
          suppressClick.current = false;
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeZoom(0.25);
          } else if (event.key === "-") {
            event.preventDefault();
            changeZoom(-0.25);
          } else if (event.key === "0") {
            event.preventDefault();
            adjust();
          } else if (event.target === event.currentTarget && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            event.currentTarget.scrollBy({
              left: event.key === "ArrowLeft" ? -60 : event.key === "ArrowRight" ? 60 : 0,
              top: event.key === "ArrowUp" ? -60 : event.key === "ArrowDown" ? 60 : 0,
            });
          }
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          if (!panAvailable || event.button !== 0 || event.pointerType === "touch") return;
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.moved && Math.hypot(dx, dy) < 5) return;
          start.moved = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.scrollLeft = start.left - dx;
          event.currentTarget.scrollTop = start.top - dy;
          event.preventDefault();
        }}
        onPointerUp={(event) => {
          suppressClick.current = drag.current?.moved ?? false;
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
          suppressClick.current = false;
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
      >
        <div className="cw-plan-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
          <div className="cw-plan-drawing" style={{ width: widthPx, height: heightPx }}>
            <FloorPlanView
              {...props}
              onSelect={
                props.onSelect
                  ? (id) => {
                      if (expanded) setExpanded(false);
                      props.onSelect?.(id);
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>
      <p id={hintId} className="cw-plan-hint">
        Glissez pour déplacer un plan agrandi. Touches + / − pour zoomer, 0 pour revenir à la vue d’ensemble.
      </p>
    </div>
  );

  return (
    <div ref={root} className="cw-plan-host">
      {expanded ? null : content}
      <dialog
        ref={dialog}
        className="cw-plan-dialog"
        aria-label={props.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
      >
        {expanded ? content : null}
      </dialog>
    </div>
  );
}
