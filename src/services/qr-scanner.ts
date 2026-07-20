import jsQR from 'jsqr';

/**
 * QR code decoding utilities.
 *
 * Proxy links (vmess://, vless://, ...) are frequently shared as QR codes.
 * These helpers decode a QR code from an image source by rendering it onto a
 * canvas and running jsQR over the pixel data. Works in both the browser (web
 * mode) and the Electron renderer since both provide canvas + Image.
 */

/** Decode a QR code from an already-loaded image element. */
function decodeFromImage(img: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas');
  const maxSide = 1600; // cap to keep decoding fast on huge screenshots
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data ?? null;
}

/** Load a Blob/File into an HTMLImageElement. */
function loadImage(src: Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    img.onload = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

/** Decode a QR code from an image File (e.g. user-selected PNG/JPG). */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const img = await loadImage(file);
  return decodeFromImage(img);
}

/**
 * Decode a QR code from whatever image is on the clipboard.
 * Returns null if the clipboard holds no image or decoding fails.
 * Requires clipboard-read permission (granted automatically in Electron).
 */
export async function decodeQrFromClipboard(): Promise<string | null> {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error('Clipboard image access is not available in this environment.');
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith('image/'));
    if (imageType) {
      const blob = await item.getType(imageType);
      const img = await loadImage(blob);
      return decodeFromImage(img);
    }
  }
  return null;
}

/** Decode every QR-ish frame from a data URL (used for drag-drop previews). */
export async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
  const img = await loadImage(dataUrl);
  return decodeFromImage(img);
}
