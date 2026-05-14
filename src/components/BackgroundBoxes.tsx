import { memo, useMemo } from 'react';
import clsx from 'clsx';

// =============================================================================
// BackgroundBoxes - port of https://ui.aceternity.com/components/background-boxes
// Recoloured monochrome: hover fills with `var(--text-primary)` and all
// borders / plus-marks derive from it via `color-mix`, so the effect tracks
// light/dark themes without a separate palette. Pointer events stay on the
// plane so hover works; an absolutely-positioned consumer (e.g. `.survey-page`)
// is expected to layer interactive content above this via z-index.
//
// Performance note (Safari): the original Aceternity demo wraps every cell
// in a `motion.div` with a `whileHover` listener. With 150×100 = 15,000
// cells that adds noticeable input lag in Safari (15K MotionValue
// subscriptions + pointer-event hit-testing while typing). The hover effect
// is `duration: 0` though - i.e. an instant background colour swap - which
// CSS `:hover` does for free at the compositor level. So we use plain divs
// and let `.bg-boxes-cell:hover` (in globals.css) handle the paint. Cell
// count is also trimmed - cells are fixed-size, the rest was clipped by
// `overflow: hidden` anyway.
// =============================================================================

export interface BackgroundBoxesProps {
  className?: string;
  /** Row count. Default 80 - enough to cover the skewed plane at every
   *  viewport size we care about; further rows are clipped invisibly. */
  rows?: number;
  /** Column count. Default 30. */
  cols?: number;
}

function BoxesInner({ className, rows = 80, cols = 30 }: BackgroundBoxesProps) {
  const rowArr = useMemo(() => Array.from({ length: rows }), [rows]);
  const colArr = useMemo(() => Array.from({ length: cols }), [cols]);

  return (
    <div className={clsx('bg-boxes-host', className)} aria-hidden>
      <div
        className="bg-boxes-plane"
        style={{
          transform:
            'translate(-40%, -60%) skewX(-48deg) skewY(14deg) scale(0.675) translateZ(0)',
        }}
      >
        {rowArr.map((_, i) => (
          <div key={`row-${i}`} className="bg-boxes-row">
            {colArr.map((_, j) => (
              <div key={`col-${j}`} className="bg-boxes-cell">
                {j % 2 === 0 && i % 2 === 0 ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="1.5"
                    stroke="currentColor"
                    className="bg-boxes-plus"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
                  </svg>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export const BackgroundBoxes = memo(BoxesInner);
