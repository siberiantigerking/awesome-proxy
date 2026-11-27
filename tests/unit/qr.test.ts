import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { buildProxyLink } from '../../src/services/node-link';
import {
  QR_LONG_TEXT_CHARS,
  QR_MAX_BYTES,
  QR_QUIET_ZONE,
  encodeQr,
  qrSvgPath,
  renderQrRgba,
  utf8ByteLength,
  type QrMatrix,
} from '../../src/services/qr-generator';
import { LINK_FIXTURES } from '../fixtures/links';
import { mulberry32 } from '../helpers/prng';

/**
 * The share dialog's QR path without the DOM: encode, draw the matrix as RGBA
 * pixels (what Copy QR image and Save PNG put on a canvas), and read the
 * pixels back with jsQR, the decoder the app's own QR import uses.
 */

function encodeOrThrow(text: string) {
  const result = encodeQr(text);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Draw at 4 px per module and decode, as a scanner would. */
function scan(matrix: QrMatrix) {
  const image = renderQrRgba(matrix, 4);
  return jsQR(image.data, image.width, image.height);
}

/** Printable ASCII from a fixed seed: a varied payload that is the same on every run. */
function asciiText(length: number, seed: number): string {
  const rand = mulberry32(seed);
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(0x21 + Math.floor(rand() * 94));
  return text;
}

function linkFixture(id: string) {
  const node = LINK_FIXTURES.find((n) => n.id === id);
  if (!node) throw new Error(`no link fixture ${id}`);
  return node;
}

describe('encodeQr, renderQrRgba, then jsQR gives the text back', () => {
  it('a short VLESS link', () => {
    const link = buildProxyLink(linkFixture('l-vless-ws-tls')).link!;
    const encoded = encodeOrThrow(link);
    expect(encoded.long).toBe(false);
    expect(scan(encoded.matrix)?.data).toBe(link);
  });

  it('a VLESS Reality+Vision link of 1,300-2,000 characters, flagged long', () => {
    const node = { ...linkFixture('l-vless-reality-vision'), name: `reality-vision-${'n'.repeat(1400)}` };
    const link = buildProxyLink(node).link!;
    expect(link.length).toBeGreaterThanOrEqual(1300);
    expect(link.length).toBeLessThanOrEqual(2000);
    const encoded = encodeOrThrow(link);
    expect(encoded.long).toBe(true);
    expect(scan(encoded.matrix)?.data).toBe(link);
  });

  it(`${QR_MAX_BYTES} bytes of ASCII, the most version 40 holds at level M`, () => {
    const text = asciiText(QR_MAX_BYTES, 0x5eed);
    const encoded = encodeOrThrow(text);
    expect(encoded.matrix.size).toBe(177);
    const decoded = scan(encoded.matrix);
    expect(decoded?.version).toBe(40);
    expect(decoded?.data).toBe(text);
  });

  it('non-ASCII text, carried as UTF-8 bytes', () => {
    const text = '🇭🇰 香港 01 — Ünïcödé';
    const decoded = scan(encodeOrThrow(text).matrix);
    expect(decoded?.binaryData).toEqual([...new TextEncoder().encode(text)]);
    expect(decoded?.data).toBe(text);
  });
});

describe('capacity limits', () => {
  it(`${QR_MAX_BYTES + 1} bytes is refused with a reason that names the sizes and none of the text`, () => {
    const text = `SECRET-${'z'.repeat(QR_MAX_BYTES + 1 - 'SECRET-'.length)}`;
    expect(utf8ByteLength(text)).toBe(QR_MAX_BYTES + 1);
    const result = encodeQr(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(String(QR_MAX_BYTES + 1));
    expect(result.reason).toContain(String(QR_MAX_BYTES));
    expect(result.reason).not.toContain('SECRET');
    expect(result.reason).not.toContain('zz');
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('香港')).toBe(6);
    expect(utf8ByteLength('🇭🇰')).toBe(8);
    // 777 three-byte characters are 2,331 bytes and fit; 778 are 2,334 bytes and don't.
    expect(encodeQr('港'.repeat(777)).ok).toBe(true);
    const over = encodeQr('港'.repeat(778));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('2334');
  });

  it(`flags a text as long only above ${QR_LONG_TEXT_CHARS} characters`, () => {
    expect(encodeOrThrow('a'.repeat(QR_LONG_TEXT_CHARS)).long).toBe(false);
    expect(encodeOrThrow('a'.repeat(QR_LONG_TEXT_CHARS + 1)).long).toBe(true);
  });
});

describe('drawing the matrix', () => {
  it('qrSvgPath paints exactly the dark modules, each once, offset by the quiet zone', () => {
    const { matrix } = encodeOrThrow(buildProxyLink(linkFixture('l-vless-reality-vision')).link!);
    const path = qrSvgPath(matrix);
    const run = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
    // The path is nothing but runs.
    expect(path.replace(run, '')).toBe('');

    const painted = new Uint8Array(matrix.size * matrix.size);
    let modules = 0;
    let outside = 0;
    let twice = 0;
    for (const [, x, y, width, back] of path.matchAll(run)) {
      expect(back).toBe(width);
      const row = Number(y) - QR_QUIET_ZONE;
      for (let col = Number(x) - QR_QUIET_ZONE, end = col + Number(width); col < end; col++) {
        modules++;
        if (row < 0 || row >= matrix.size || col < 0 || col >= matrix.size) {
          outside++;
          continue;
        }
        if (painted[row * matrix.size + col]) twice++;
        painted[row * matrix.size + col] = 1;
      }
    }
    expect(outside).toBe(0);
    expect(twice).toBe(0);
    expect(modules).toBe(matrix.dark.reduce((sum, v) => sum + v, 0));
    expect(Array.from(painted)).toEqual(Array.from(matrix.dark));
  });

  it('renderQrRgba draws black on opaque white, with the quiet zone around it', () => {
    const { matrix } = encodeOrThrow('quiet zone');
    const image = renderQrRgba(matrix, 3);
    expect(image.width).toBe((matrix.size + 2 * QR_QUIET_ZONE) * 3);
    expect(image.height).toBe(image.width);
    expect(image.data.length).toBe(image.width * image.height * 4);
    expect(Array.from(image.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
    // Module (0, 0) is the corner of the top-left finder pattern, which is always dark.
    const corner = (QR_QUIET_ZONE * 3 * image.width + QR_QUIET_ZONE * 3) * 4;
    expect(Array.from(image.data.slice(corner, corner + 4))).toEqual([0, 0, 0, 255]);
  });
});
