import React from 'react';
import { QR_QUIET_ZONE, qrSvgPath, type QrMatrix } from '../services/qr-generator';

/**
 * A QR code on screen: one SVG with a white square and a single black path of
 * the dark modules, quiet zone included.
 *
 * Drawn as React SVG elements, so no markup is ever parsed (no innerHTML),
 * which keeps it working under the production CSP and means a payload can't
 * inject anything. Always black on white: some phone scanners fail on
 * inverted codes, and the white square keeps the quiet zone light in dark
 * mode too.
 *
 * Only ShareDialog renders this, inside its lazy chunk, so importing
 * qr-generator here does not pull the QR library into the main chunk.
 */
export default function QrCode({ matrix, size }: { matrix: QrMatrix; size: number }) {
  // A version 40 code has thousands of runs; build the path once per code,
  // not on every re-render of the dialog (feedback text, Show/Hide).
  const path = React.useMemo(() => qrSvgPath(matrix), [matrix]);
  const extent = matrix.size + 2 * QR_QUIET_ZONE;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      // Module edges on whole pixels: anti-aliased edges blur the gaps
      // between modules, which costs scanners contrast.
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
