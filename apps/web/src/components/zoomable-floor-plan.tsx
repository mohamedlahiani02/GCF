import { FloorPlanView, PLAN_WIDTH, planHeight, type FloorPlanViewProps } from "@gcf/floorplan";
import { useId, useLayoutEffect, useRef, useState } from "react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const bounded = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Zoom changes only the view: resource coordinates and the shared portal renderer stay untouched. */
export function ZoomableFloorPlan(props: FloorPlanViewProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const previous = useRef<{ width: number; height: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [availableHeight, setAvailableHeight] = useState(260);
  const [manualScale, setManualScale] = useState<number | null>(null);
  const hintId = useId();
  const height = planHeight(props.layout, props.image);
  const fit = Math.min(size.width / PLAN_WIDTH, size.height / height, MAX_SCALE);
  const scale = manualScale ?? fit;
  const widthPx = PLAN_WIDTH * scale;
  const heightPx = height * scale;
  const canvasWidth = Math.max(size.width, widthPx);
  const canvasHeight = Math.max(size.height, heightPx);
  const zoom = (factor: number) => setManualScale((value) => bounded((value ?? fit) * factor));
  const fitToScreen = () => {
    if (viewport.current) setAvailableHeight(Math.max(220, Math.min(640, window.innerHeight - viewport.current.getBoundingClientRect().top - 24)));
    setManualScale(null);
  };

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      setAvailableHeight(Math.max(220, Math.min(640, window.innerHeight - element.getBoundingClientRect().top - 24)));
      setSize((old) =>
        old.width === element.clientWidth && old.height === element.clientHeight ? old : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const main = element.closest("main");
    if (main) observer.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    const old = previous.current;
    if (!element) return;
    // Keep the centre of the inspected area stable when a zoom button changes the canvas size.
    if (old && old.width > 0 && old.height > 0) {
      element.scrollLeft = ((element.scrollLeft + size.width / 2) / old.width) * canvasWidth - size.width / 2;
      element.scrollTop = ((element.scrollTop + size.height / 2) / old.height) * canvasHeight - size.height / 2;
    }
    previous.current = { width: canvasWidth, height: canvasHeight };
  }, [canvasWidth, canvasHeight, size.width, size.height]);

  return (
    <div className="cw-plan-viewer">
      <div className="cw-plan-toolbar" role="group" aria-label="Zoom du plan">
        <span className="lab">Affichage du plan</span>
        <div className="cw-plan-zoom">
          <button type="button" className="btn" aria-label="Réduire le plan" disabled={scale <= MIN_SCALE} onClick={() => zoom(1 / 1.25)}>
            −
          </button>
          <output aria-live="polite" aria-label="Niveau de zoom">
            {Math.round(scale * 100)} %
          </output>
          <button type="button" className="btn" aria-label="Agrandir le plan" disabled={scale >= MAX_SCALE} onClick={() => zoom(1.25)}>
            +
          </button>
        </div>
        <button type="button" className="btn" aria-pressed={manualScale === null} onClick={fitToScreen}>
          Ajuster à l’écran
        </button>
        <button type="button" className="btn btn-g" onClick={() => setManualScale(1)}>
          100 %
        </button>
      </div>
      <p id={hintId} className="visually-hidden">
        Utilisez les boutons ou les touches + et − pour zoomer, 0 pour ajuster le plan. Les flèches permettent de parcourir un plan agrandi.
      </p>
      <div
        ref={viewport}
        className="cw-plan-viewport"
        style={{ height: availableHeight }}
        role="region"
        aria-label="Plan coworking avec zoom"
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoom(1.25);
          } else if (event.key === "-") {
            event.preventDefault();
            zoom(1 / 1.25);
          } else if (event.key === "0") {
            event.preventDefault();
            fitToScreen();
          }
        }}
      >
        <div className="cw-plan-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
          <div className="cw-plan-drawing" style={{ width: widthPx, height: heightPx }}>
            <FloorPlanView {...props} />
          </div>
        </div>
      </div>
    </div>
  );
}
