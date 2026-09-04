'use client';

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * A QR code, rendered as inline SVG.
 *
 * Inline rather than an image, for two reasons that both matter here. The
 * content-security policy allows no external images, and an `otpauth://` URI
 * carries the TOTP seed — turning it into a file that could be fetched, cached
 * or logged by anything other than this page is exactly the wrong shape for it.
 * As markup it exists only in the rendered document.
 *
 * Error correction is deliberately low. The payload is long, higher correction
 * makes the matrix denser, and a denser code is harder for a phone camera to
 * read off a screen — which is the only thing this code is ever pointed at.
 */
export function QrCode({ value, size = 208 }: { value: string; size?: number }) {
  const path = useMemo(() => {
    // 0 = choose the smallest type version that fits the payload.
    const qr = qrcode(0, 'L');
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    const parts: string[] = [];

    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (qr.isDark(row, column)) parts.push(`M${column},${row}h1v1h-1z`);
      }
    }

    return { d: parts.join(''), count };
  }, [value]);

  const quiet = 2; // The specification asks for 4; 2 is enough on a screen.
  const extent = path.count + quiet * 2;

  return (
    <svg
      viewBox={`${-quiet} ${-quiet} ${extent} ${extent}`}
      width={size}
      height={size}
      // The secret is offered as text beside this, which is what a screen-reader
      // user or anyone typing it by hand actually needs. Announcing a QR code
      // adds nothing, so it is hidden rather than given a useless label.
      aria-hidden
      className="rounded bg-white p-2"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
