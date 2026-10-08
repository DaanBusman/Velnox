import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@velnox/config';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';

/** Long enough for Caddy to adapt the Caddyfile and provision; a reload is quick. */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * Caddy's admin API, reached over its Unix socket (ADR-045).
 *
 * One call: load the Caddyfile again. Caddy adapts it itself, reading the
 * certificate files the API has just written, and either switches to the new
 * configuration or refuses it and keeps serving the old one — it never serves
 * half of a change. Nothing else of the admin API is used, and the socket is in
 * a volume only Caddy and the API mount: no port, on no network.
 */
@Injectable()
export class CaddyAdminService {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async reload(): Promise<void> {
    const caddyfile = await readFile(this.config.VELNOX_CADDYFILE);
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: this.config.VELNOX_CADDY_ADMIN_SOCKET,
            method: 'POST',
            path: '/load',
            // Caddy checks the Host of admin requests; over its socket, localhost.
            headers: {
              host: 'localhost',
              'content-type': 'text/caddyfile',
              'content-length': caddyfile.length,
            },
            timeout: LOAD_TIMEOUT_MS,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(new Error('Caddy did not answer in time')));
        req.on('error', reject);
        req.end(caddyfile);
      },
    ).catch((error: unknown) => {
      throw new VelnoxError(ERROR_CODES.tlsProxyUnreachable, {
        status: 503,
        params: { detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      });
    });

    if (status !== 200) {
      // Caddy's own reason, which names the file or the directive. It carries no
      // key material: Caddy reports paths, not contents.
      let detail = body;
      try {
        detail = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        /* not JSON: keep the text */
      }
      throw new VelnoxError(ERROR_CODES.tlsApplyFailed, {
        status: 400,
        params: { detail: detail.slice(0, 400) },
      });
    }
  }
}
