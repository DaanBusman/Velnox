import { Client } from 'ssh2';
import {
  HostKeyMismatchError,
  SshAuthError,
  SshUnreachableError,
  fingerprintOf,
  type SshTarget,
} from '../library/ssh';
import { commandLine, type CommandSpec } from './commands';

/**
 * Run one registered command on a node over SSH (ADR-046).
 *
 * The connection is the one SFTP uses: the confirmed host key or no
 * connection, key authentication only. Output is passed on as it arrives, so
 * a job shows a dist-upgrade line by line. A command whose spec is not
 * interruptible runs to its end even when the job is cancelled; only its own
 * timeout stops it.
 */

const CONNECT_TIMEOUT_MS = 15_000;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class CommandTimeoutError extends Error {
  constructor(id: string, ms: number) {
    super(`${id} did not finish within ${Math.round(ms / 60_000)} minutes`);
    this.name = 'CommandTimeoutError';
  }
}

/** Keep at most this much of each stream for the result; the job log has all of it. */
const KEEP_BYTES = 256 * 1024;

export function runCommand(
  target: SshTarget,
  spec: CommandSpec,
  node: string,
  options: {
    signal?: AbortSignal;
    onOutput?: (stream: 'STDOUT' | 'STDERR', text: string) => void;
  } = {},
): Promise<CommandResult> {
  const command = commandLine(spec, node, target.username);
  return new Promise<CommandResult>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let mismatch: HostKeyMismatchError | null = null;
    let stdout = '';
    let stderr = '';
    const keep = (current: string, text: string) =>
      (current + text).length > KEEP_BYTES ? (current + text).slice(-KEEP_BYTES) : current + text;

    const timer = setTimeout(
      () => finish(new CommandTimeoutError(spec.id, spec.timeoutMs)),
      spec.timeoutMs,
    );
    const finish = (error: unknown, result?: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      client.end();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = (): void => {
      if (spec.interruptible) finish(new Error('Cancelled'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stdout = keep(stdout, text);
          options.onOutput?.('STDOUT', text);
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stderr = keep(stderr, text);
          options.onOutput?.('STDERR', text);
        });
        stream.on('close', (code: number | null) => {
          finish(null, { exitCode: typeof code === 'number' ? code : null, stdout, stderr });
        });
      });
    });

    client.on('error', (error: Error & { level?: string }) => {
      if (mismatch) finish(mismatch);
      else if (error.level === 'client-authentication') finish(new SshAuthError(target.host));
      else finish(new SshUnreachableError(target.host, error));
    });
    client.on('close', () =>
      finish(mismatch ?? new SshUnreachableError(target.host, new Error('Connection closed'))),
    );

    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
      readyTimeout: CONNECT_TIMEOUT_MS,
      tryKeyboard: false,
      // Keep the session up through a long, quiet dpkg trigger.
      keepaliveInterval: 30_000,
      hostVerifier: (key: Buffer) => {
        const presented = fingerprintOf(key);
        if (presented === target.fingerprint) return true;
        mismatch = new HostKeyMismatchError(target.host, target.fingerprint, presented);
        return false;
      },
    });
  });
}

/**
 * Collect a command's output into a job's log in lines, not in whatever pieces
 * the network delivered — a line split across two packets is one log line.
 */
export function lineBuffer(write: (stream: 'STDOUT' | 'STDERR', text: string) => Promise<void>): {
  push: (stream: 'STDOUT' | 'STDERR', text: string) => void;
  flush: () => Promise<void>;
} {
  const pending: Record<'STDOUT' | 'STDERR', string> = { STDOUT: '', STDERR: '' };
  let chain = Promise.resolve();
  const emit = (stream: 'STDOUT' | 'STDERR', text: string) => {
    chain = chain.then(() => write(stream, text)).catch(() => undefined);
  };
  return {
    push(stream, text) {
      pending[stream] += text;
      const cut = pending[stream].lastIndexOf('\n');
      if (cut >= 0) {
        emit(stream, pending[stream].slice(0, cut));
        pending[stream] = pending[stream].slice(cut + 1);
      }
    },
    async flush() {
      for (const stream of ['STDOUT', 'STDERR'] as const) {
        if (pending[stream]) emit(stream, pending[stream]);
        pending[stream] = '';
      }
      await chain;
    },
  };
}
