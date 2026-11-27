import qrcode from 'qrcode-generator';

/**
 * QR code generation for the share dialog: text in, module matrix out, plus
 * the two ways the dialog draws a matrix (an SVG path on screen, RGBA pixels
 * for Copy QR image and Save PNG).
 *
 * This is the only module that imports qrcode-generator, and only the share
 * dialog's components (ShareDialog, QrCode) import this one. The pages load
 * the dialog with a dynamic import, so the library ends up in the dialog's
 * lazy chunk and the main chunk does not grow, the same arrangement as jsQR
 * in qr-scanner.ts.
 *
 * Pure: no DOM, no canvas, no logging. Failure reasons carry sizes only and
 * never the text, because the text is usually a share link or a subscription
 * URL, and either one is a credential.
 */

/**
 * Error correction level M: the code still reads with about 15% of it damaged
 * or misread. L leaves little margin for a phone camera pointed at a screen
 * (glare, moiré, a cursor over the code); Q and H cost so much capacity that a
 * long Reality link would need a far denser code, which is harder to scan.
 */
export const QR_ERROR_CORRECTION = 'M' as const;

/**
 * Light margin around the symbol, in modules. The QR spec asks for 4: scanners
 * use it to find the three finder patterns, and a code drawn up to the edge of
 * a dark dialog or a dark chat background often fails to scan.
 */
export const QR_QUIET_ZONE = 4;

/**
 * The most a QR code holds at level M. Version 40, the largest symbol (177 x
 * 177 modules), has 2,334 data codewords; byte mode spends 20 bits of them on
 * its header (a 4-bit mode and a 16-bit length), which leaves 2,331 bytes.
 */
export const QR_MAX_BYTES = 2331;

/**
 * Past about 1,200 characters the modules get so small that phones, scanning
 * from a screen in particular, often fail to lock on. The code is still shown,
 * with a note that copying the text is more reliable.
 */
export const QR_LONG_TEXT_CHARS = 1200;

const utf8 = new TextEncoder();

/** Size of `text` in UTF-8, which is what the code carries (see encodeQr). */
export function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
}

/** A QR symbol without its quiet zone: `size` x `size` modules, row-major, 1 = dark. */
export interface QrMatrix {
  size: number;
  dark: Uint8Array;
}

export type QrEncodeResult =
  | { ok: true; matrix: QrMatrix; long: boolean }
  | { ok: false; reason: string };

/** RGBA pixels of a rendered code: `width * height * 4` bytes. */
export interface QrRgba {
  width: number;
  height: number;
  /** ArrayBuffer-backed, because `new ImageData()` accepts nothing else. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

function tooLongReason(bytes: number): string {
  return (
    `This is too long for a QR code: it is ${bytes} bytes, and a QR code holds at most ` +
    `${QR_MAX_BYTES} bytes. Copy it as text instead.`
  );
}

/**
 * Encode `text` at level M, letting the library pick the smallest version that
 * fits. Never throws.
 *
 * The text goes in as UTF-8. qrcode-generator's byte mode keeps only the low
 * byte of each UTF-16 unit (`charCodeAt(i) & 0xff`), which would garble a node
 * name such as "🇭🇰 香港 01", and its ES module build has no UTF-8 converter.
 * So the UTF-8 bytes are handed over as a "binary string", one character per
 * byte, which that conversion passes through unchanged; phone clients read the
 * byte segment as UTF-8.
 *
 * The size is checked before encoding so that the reason can name the sizes;
 * the library would only throw a bare "code length overflow" string.
 */
export function encodeQr(text: string): QrEncodeResult {
  const bytes = utf8.encode(text);
  if (bytes.length > QR_MAX_BYTES) return { ok: false, reason: tooLongReason(bytes.length) };

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  try {
    const qr = qrcode(0, QR_ERROR_CORRECTION);
    qr.addData(binary, 'Byte');
    qr.make();
    const size = qr.getModuleCount();
    const dark = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) dark[row * size + col] = 1;
      }
    }
    return { ok: true, matrix: { size, dark }, long: text.length > QR_LONG_TEXT_CHARS };
  } catch {
    // Unreachable after the size check, in theory. The library throws plain
    // strings; none is passed on, so nothing of the text can reach the UI.
    return { ok: false, reason: `Couldn't make a QR code from this text (${bytes.length} bytes).` };
  }
}

/**
 * The dark modules as one SVG path for a square viewBox of
 * `size + 2 * QR_QUIET_ZONE` units: an `M x y h n v1 h-n z` rectangle per
 * horizontal run of dark modules, offset by the quiet zone.
 *
 * One path rather than a rect per module keeps even a version 40 code to a
 * single element, and React sets it as an attribute, so no markup is parsed.
 */
export function qrSvgPath(matrix: QrMatrix): string {
  const { size, dark } = matrix;
  const runs: string[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!dark[row * size + col]) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && dark[row * size + col]) col++;
      const length = col - start;
      runs.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${length}v1h-${length}z`);
    }
  }
  return runs.join('');
}

/**
 * The code as RGBA pixels, `scale` pixels per module, quiet zone included:
 * the input for canvas `putImageData` (Copy QR image, Save PNG) and for jsQR in
 * the tests. Black on opaque white, never transparent, so a pasted or saved
 * image still scans on a dark background.
 */
export function renderQrRgba(matrix: QrMatrix, scale: number): QrRgba {
  // Whole pixels per module; a fractional scale would blur module edges.
  const px = Math.max(1, Math.floor(scale));
  const width = (matrix.size + 2 * QR_QUIET_ZONE) * px;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.dark[row * matrix.size + col]) continue;
      const x0 = (col + QR_QUIET_ZONE) * px;
      const y0 = (row + QR_QUIET_ZONE) * px;
      for (let y = y0; y < y0 + px; y++) {
        for (let i = (y * width + x0) * 4, end = i + px * 4; i < end; i += 4) {
          // Alpha stays 255 from the white fill.
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { width, height: width, data };
}
