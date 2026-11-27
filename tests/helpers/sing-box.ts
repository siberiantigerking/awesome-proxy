import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/** The bundled core. The suites only ever read it; they never copy or replace it. */
export const SING_BOX = fileURLToPath(new URL('../../resources/bin/sing-box.exe', import.meta.url));

/** False on a checkout without the binary: the core suites then skip with a message. */
export const HAS_CORE = fs.existsSync(SING_BOX);

/**
 * `sing-box check -c stdin`: validates the config without starting anything,
 * needs no admin rights and writes no files. `cwd` is a throwaway folder so a
 * relative path in a config could never land in the repo.
 */
export function checkConfig(config: object, cwd: string): { status: number | null; output: string } {
  const r = spawnSync(SING_BOX, ['check', '-c', 'stdin'], {
    input: JSON.stringify(config),
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 60000,
    cwd,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
  return { status: r.status, output };
}

/**
 * True when nothing holds `port` on 127.0.0.1, for TCP or UDP. Loopback only:
 * binding a wildcard address could raise a Windows Firewall prompt.
 */
export async function portIsFree(port: number): Promise<boolean> {
  const tcpFree = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
  if (!tcpFree) return false;
  return new Promise<boolean>((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      try {
        sock.close();
      } catch {
        /* never bound, nothing to close */
      }
      resolve(false);
    });
    sock.bind(port, '127.0.0.1', () => sock.close(() => resolve(true)));
  });
}

export interface RunningCore {
  child: ChildProcessWithoutNullStreams;
  /** Every output line so far, stdout and stderr interleaved. */
  lines: string[];
  /** Resolves with the exit code (or signal) once the process is gone. */
  exited: Promise<number | string | null>;
  /** True once the process has exited. */
  hasExited: () => boolean;
}

/**
 * `sing-box run -c stdin`. Only for System/Manual configs on spare loopback
 * ports: the caller must have checked that the config has no TUN inbound and
 * that its ports are free. The caller kills it.
 */
export function startCore(config: object, cwd: string): RunningCore {
  const child = spawn(SING_BOX, ['run', '-c', 'stdin'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let done = false;
  const collect = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    });
    stream.on('end', () => {
      if (buffer) lines.push(buffer);
    });
  };
  collect(child.stdout);
  collect(child.stderr);
  const exited = new Promise<number | string | null>((resolve) => {
    child.once('exit', (code, signal) => {
      done = true;
      resolve(code ?? signal);
    });
    child.once('error', (err) => {
      done = true;
      lines.push(`spawn error: ${err.message}`);
      resolve(null);
    });
  });
  child.stdin.end(JSON.stringify(config));
  return { child, lines, exited, hasExited: () => done };
}

/** Poll `pred` every 50 ms until it is true (→ true) or `ms` has passed (→ false). */
export async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}
