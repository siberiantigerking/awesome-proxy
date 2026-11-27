import React from 'react';
import type { ProxyNode, Subscription } from '../types';
import { buildProxyLink, buildShareBundle, buildWireguardConfig } from '../services/node-link';
import { encodeQr, renderQrRgba, QR_QUIET_ZONE, type QrMatrix } from '../services/qr-generator';
import QrCode from './QrCode';

/**
 * The share dialog: a node's link (or a WireGuard node's config), several
 * nodes' links, or a subscription URL, as text and as a QR code.
 *
 * Loaded lazily. The Nodes and Subscriptions pages import this module with a
 * dynamic import() on the first Share click, and it brings QrCode,
 * qr-generator and the QR library with it, so none of them is in the main
 * chunk (the same arrangement as jsQR for scanning).
 *
 * Privacy: a share link or a subscription URL IS the credential. Anyone who
 * has it can use the node, or every node of the subscription, and its
 * traffic. So the text stays masked until Show, nothing of the real code is
 * drawn until Show QR, and a warning stays in view. No payload goes into a
 * log, a title or aria attribute, a React key or an error message, and the
 * feedback line uses fixed texts only, never an error's message.
 *
 * No IPC. Copy QR image uses the renderer's async clipboard, as the QR import
 * already does, so the preload API is unchanged and web mode works the same.
 * Where the clipboard refuses an image, the message points at Save PNG.
 */

export type ShareTarget =
  | { kind: 'node'; node: ProxyNode }
  | { kind: 'nodes'; nodes: ProxyNode[] }
  | { kind: 'subscription'; subscription: Subscription };

/** Stands in for the text until Show. A fixed length, so it doesn't hint at the secret's length. */
const MASK = '••••••••••••';

/** The on-screen size a code aims for, in CSS pixels (see screenSize). */
const QR_SCREEN_PX = 300;

/** Pixels per module in a copied or saved PNG: about 230 px for a short link, 1,480 px for the largest code. */
const PNG_SCALE = 8;

const WARNING = {
  node:
    "Anyone who scans this code or gets this link can use this node and its traffic. Don't screenshot it " +
    'or show it while screen-sharing.',
  wireguard:
    "Anyone who scans this code or gets this config can use this node and its traffic. Don't screenshot it " +
    'or show it while screen-sharing.',
  nodes:
    "Anyone who scans these codes or gets these links can use these nodes and their traffic. Don't " +
    'screenshot them or show them while screen-sharing.',
  subscription:
    'Anyone who scans this code or gets this URL gets every node in the subscription and uses its traffic. ' +
    "Don't screenshot it or show it while screen-sharing.",
};

/** One QR code of the dialog: the text it encodes and the name the pager shows. */
interface QrPage {
  text: string;
  name: string;
}

interface Heading {
  title: string;
  subtitle: string;
}

/** Something to share. One page per QR code; only several nodes have more than one. */
interface Shareable extends Heading {
  pages: QrPage[];
  /** What Show reveals and the first copy button copies. */
  text: string;
  textLabel: string;
  copyLabel: string;
  warning: string;
  /** Something the shared text can't carry (WireGuard reserved bytes). */
  caveat?: string;
  /** Save PNG's file name. Several nodes get no image actions, so no name. */
  pngName?: string;
  /** Several nodes only. */
  bundle?: { base64: string; txtName: string; skipped: { name: string; reason: string }[] };
}

/** Nothing to share (OpenVPN, ShadowTLS, a WireGuard node without keys), and why. */
interface Unshareable extends Heading {
  reason: string;
}

type ShareView = Shareable | Unshareable;

function nodeName(node: ProxyNode): string {
  return node.name || 'Unnamed node';
}

/**
 * A name made safe as a file name: each run of characters outside
 * A-Z a-z 0-9 . _ - becomes one '_', at most 60 characters, no '.' or '_' at
 * either end (a trailing dot is invalid on Windows). Node names are often all
 * emoji or CJK, hence the fallback.
 */
function safeFileStem(name: string, fallback: string): string {
  const stem = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60).replace(/^[._]+|[._]+$/g, '');
  return stem || fallback;
}

function describeTarget(target: ShareTarget): ShareView {
  if (target.kind === 'subscription') {
    const { name, url } = target.subscription;
    return {
      title: name,
      subtitle: 'Subscription URL',
      pages: [{ text: url, name }],
      text: url,
      textLabel: 'URL',
      copyLabel: 'Copy URL',
      warning: WARNING.subscription,
      pngName: `${safeFileStem(name, 'subscription')}-subscription-qr.png`,
    };
  }

  if (target.kind === 'nodes') {
    const { links, shared, skipped, text, base64 } = buildShareBundle(target.nodes);
    const count = target.nodes.length;
    return {
      title: `Share ${count} node${count === 1 ? '' : 's'}`,
      subtitle: skipped.length
        ? `${links.length} of ${count} ${links.length === 1 ? 'has' : 'have'} a share link`
        : `${count} share link${count === 1 ? '' : 's'}`,
      pages: links.map((link, i) => ({ text: link, name: nodeName(shared[i]) })),
      text,
      textLabel: 'Links, one per line',
      copyLabel: 'Copy all links',
      warning: WARNING.nodes,
      bundle: { base64, txtName: `awesome-proxy-${links.length}-nodes.txt`, skipped },
    };
  }

  const { node } = target;
  const heading = { title: nodeName(node), subtitle: node.type.toUpperCase() };

  if (node.type === 'wireguard') {
    // WireGuard has no share link. Its standard config text is what the
    // official apps import, from a file or from a QR code of that text.
    const { config, warning, error } = buildWireguardConfig(node);
    if (!config) return { ...heading, reason: error || 'There is no config to export for this node.' };
    return {
      ...heading,
      pages: [{ text: config, name: heading.title }],
      text: config,
      textLabel: 'WireGuard config',
      copyLabel: 'Copy as WireGuard config',
      warning: WARNING.wireguard,
      caveat: warning,
      pngName: `${safeFileStem(node.name, 'node')}-wireguard-qr.png`,
    };
  }

  // OpenVPN and ShadowTLS have no link format; buildProxyLink says why.
  const { link, error } = buildProxyLink(node);
  if (!link) return { ...heading, reason: error || 'Could not build a link for this node.' };
  return {
    ...heading,
    pages: [{ text: link, name: heading.title }],
    text: link,
    textLabel: 'Link',
    copyLabel: 'Copy link',
    warning: WARNING.node,
    pngName: `${safeFileStem(node.name, 'node')}-qr.png`,
  };
}

/**
 * What the text box shows until Show: the scheme, or WireGuard's section
 * header, which tells what kind of text it is, and nothing of the secret.
 */
function maskText(text: string): string {
  if (text.startsWith('[Interface]')) return `[Interface] ${MASK}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  return `${scheme ? scheme[0] : ''}${MASK}`;
}

/**
 * On-screen size of a code: about QR_SCREEN_PX, in whole CSS pixels per
 * module and at least 2. A dense code (a long Reality link is version 30 or
 * more) is drawn a little larger instead of with modules too small for a
 * phone camera to resolve.
 */
function screenSize(matrix: QrMatrix): number {
  const units = matrix.size + 2 * QR_QUIET_ZONE;
  return units * Math.max(2, Math.round(QR_SCREEN_PX / units));
}

/**
 * The code as a PNG, black on opaque white with its quiet zone. Null when the
 * canvas can't draw. Async, so that a canvas error becomes a rejection the
 * callers' catch turns into a fixed message.
 */
async function qrPng(matrix: QrMatrix): Promise<Blob | null> {
  const { width, height, data } = renderQrRgba(matrix, PNG_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** False where there is no async clipboard (web mode served over plain http). */
async function writeClipboardText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

/** False where the clipboard can't take an image (no ClipboardItem or clipboard.write). */
async function writeClipboardPng(matrix: QrMatrix): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  const blob = await qrPng(matrix);
  if (!blob) return false;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

/** Save through the download path, as the Logs page's Export does. */
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Decoy grid for the hidden state: version 1's 21 modules plus its quiet zone. */
const PLACEHOLDER_UNITS = 29;

/**
 * Three finder squares and a fixed scatter of modules, the same for every
 * code. A decoy rather than the real code blurred: a blurred code can still be
 * read, or sharpened from a screenshot, so nothing of it is drawn until Show QR.
 */
const PLACEHOLDER_PATH = (() => {
  const parts: string[] = [];
  for (const [x, y] of [[4, 4], [18, 4], [4, 18]]) {
    // Ring and centre of a finder pattern, filled with the even-odd rule.
    parts.push(`M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}h5v5h-5zM${x + 2} ${y + 2}h3v3h-3z`);
  }
  for (let row = 0; row < 21; row++) {
    for (let col = 0; col < 21; col++) {
      const inFinder = (row < 8 && (col < 8 || col > 12)) || (row > 12 && col < 8);
      if (!inFinder && ((row * 7 + col * 13) ^ (row * col)) % 5 < 2) {
        parts.push(`M${col + 4} ${row + 4}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
})();

function QrPlaceholder({ size }: { size: number }) {
  return (
    <>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${PLACEHOLDER_UNITS} ${PLACEHOLDER_UNITS}`}
        aria-hidden="true"
        className="blur-[3px] opacity-30"
      >
        <path d={PLACEHOLDER_PATH} fill="#000000" fillRule="evenodd" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-surface-700">
        QR code hidden
      </span>
    </>
  );
}

export default function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const view = React.useMemo(() => describeTarget(target), [target]);
  // Consts, so that the click handlers below keep the narrowing.
  const shareable = 'reason' in view ? null : view;
  const bundle = shareable?.bundle;
  const pages = shareable?.pages ?? [];

  const [page, setPage] = React.useState(0);
  const [textShown, setTextShown] = React.useState(false);
  const [qrShown, setQrShown] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ text: string; ok: boolean } | null>(null);

  const index = Math.min(page, Math.max(0, pages.length - 1));
  const current: QrPage | undefined = pages[index];
  // Encoded as soon as the dialog opens, though drawn only after Show QR: the
  // capacity check decides whether the image buttons work at all.
  const qr = React.useMemo(() => (current ? encodeQr(current.text) : null), [current]);
  const qrSize = qr?.ok ? screenSize(qr.matrix) : 0;

  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  // The latest onClose, so the effect below runs once: re-running it on a
  // parent re-render would pull focus back to Close in the middle of use.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  // As ConfirmDialog: focus moves into the dialog and Escape closes it, bound
  // on document so it works whatever has focus. On close, focus goes back to
  // the button that opened the dialog, if it is still on the page.
  React.useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const copyText = async (text: string) => {
    const ok = await writeClipboardText(text).catch(() => false);
    setFeedback({ text: ok ? 'Copied.' : "Couldn't copy to the clipboard.", ok });
  };

  const copyImage = async () => {
    if (!qr?.ok) return;
    const ok = await writeClipboardPng(qr.matrix).catch(() => false);
    setFeedback({ text: ok ? 'QR image copied.' : "Couldn't copy the image here. Use Save PNG instead.", ok });
  };

  const savePng = async () => {
    if (!qr?.ok || !shareable?.pngName) return;
    const blob = await qrPng(qr.matrix).catch(() => null);
    if (blob) download(blob, shareable.pngName);
    else setFeedback({ text: "Couldn't make the image.", ok: false });
  };

  const saveTxt = () => {
    if (!shareable || !bundle) return;
    download(new Blob([shareable.text], { type: 'text/plain' }), bundle.txtName);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="bg-surface-800 border border-surface-700 rounded-xl w-[540px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-surface-700">
          <h3 id="share-dialog-title" className="text-base font-semibold text-surface-100 break-words">
            {view.title}
          </h3>
          <p className="text-xs text-surface-500 mt-1">{view.subtitle}</p>
        </div>

        <div className="p-4 flex-1 overflow-y-auto space-y-3">
          {'reason' in view ? (
            <div className="space-y-1">
              <p className="text-sm text-surface-300 break-words">{view.reason}</p>
              <p className="text-xs text-surface-500">No QR code can be made for this node.</p>
            </div>
          ) : (
            <>
              {current && (
                <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
                  <p className="text-[11px] text-yellow-300">{view.warning}</p>
                </div>
              )}

              {view.caveat && <p className="text-[11px] text-yellow-300">{view.caveat}</p>}

              {current && qr && (
                <div className="flex flex-col items-center gap-2">
                  {bundle && (
                    <div className="flex items-center justify-center gap-2 w-full">
                      <button
                        onClick={() => setPage(index - 1)}
                        disabled={index === 0}
                        className="btn-icon disabled:opacity-40"
                        aria-label="Previous node"
                      >
                        ←
                      </button>
                      <span className="text-xs text-surface-400 text-center break-words min-w-0">
                        {index + 1} of {pages.length} — {current.name}
                      </span>
                      <button
                        onClick={() => setPage(index + 1)}
                        disabled={index >= pages.length - 1}
                        className="btn-icon disabled:opacity-40"
                        aria-label="Next node"
                      >
                        →
                      </button>
                    </div>
                  )}

                  {qr.ok ? (
                    <>
                      <div className="relative flex rounded-lg overflow-hidden bg-white">
                        {qrShown ? <QrCode matrix={qr.matrix} size={qrSize} /> : <QrPlaceholder size={qrSize} />}
                      </div>
                      <button
                        onClick={() => setQrShown((shown) => !shown)}
                        className="btn-secondary text-xs px-3 py-1"
                      >
                        {qrShown ? 'Hide QR' : 'Show QR'}
                      </button>
                      {qr.long && (
                        <p className="text-[11px] text-yellow-300 text-center">
                          This text is long ({current.text.length} characters), so phones may struggle to scan
                          the code. {view.copyLabel} is more reliable.
                        </p>
                      )}
                    </>
                  ) : (
                    // Too long for any QR code: the reason names the sizes only.
                    <p className="text-xs text-red-300 text-center">{qr.reason}</p>
                  )}
                </div>
              )}

              {current && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-surface-400">{view.textLabel}</span>
                    <button
                      onClick={() => setTextShown((shown) => !shown)}
                      className="text-[11px] text-primary-400 hover:text-primary-300"
                    >
                      {textShown ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {textShown ? (
                    <textarea
                      readOnly
                      spellCheck={false}
                      value={view.text}
                      aria-label={view.textLabel}
                      className="input-field h-32 resize-none font-mono text-xs"
                    />
                  ) : (
                    <p className="input-field font-mono text-xs text-surface-500 whitespace-pre-line break-all max-h-32 overflow-y-auto">
                      {pages.map((p) => maskText(p.text)).join('\n')}
                    </p>
                  )}
                </div>
              )}

              {bundle && bundle.skipped.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-surface-400">
                    {current ? 'Not included (no share link):' : 'None of these nodes has a share link:'}
                  </p>
                  <ul className="text-[11px] text-surface-500 space-y-0.5 max-h-28 overflow-y-auto">
                    {bundle.skipped.map((skip, i) => (
                      <li key={i} className="break-words">
                        {skip.name} — {skip.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-surface-700 space-y-2">
          {/* Next to the buttons rather than at the end of the body, which
              scrolls out of view in a small window. */}
          {feedback && (
            <p role="status" className={`text-[11px] text-right ${feedback.ok ? 'text-green-400' : 'text-red-300'}`}>
              {feedback.text}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {shareable && current && (
              <button onClick={() => void copyText(shareable.text)} className="btn-primary">
                {shareable.copyLabel}
              </button>
            )}
            {bundle && current && (
              <>
                <button onClick={() => void copyText(bundle.base64)} className="btn-secondary">
                  Copy as base64 subscription
                </button>
                <button onClick={saveTxt} className="btn-secondary">
                  Save .txt
                </button>
              </>
            )}
            {shareable && current && !bundle && (
              <>
                <button onClick={() => void copyImage()} disabled={!qr?.ok} className="btn-secondary">
                  Copy QR image
                </button>
                <button onClick={() => void savePng()} disabled={!qr?.ok} className="btn-secondary">
                  Save PNG
                </button>
              </>
            )}
            <button ref={closeRef} onClick={onClose} className="btn-secondary">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
