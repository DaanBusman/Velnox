import { Controller, Get, Header, Inject, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';
import { QueueService } from '../infrastructure/queue.service';
import { HealthService } from '../health/health.service';

/**
 * Prometheus exposition, off by default.
 *
 * Written by hand rather than pulled in as a client library: Phase 1 has a
 * handful of gauges, and a metrics library is a dependency on the critical path
 * of a process that holds hypervisor credentials. If the metric set grows past
 * what this can carry, that trade changes.
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly queue: QueueService,
    private readonly health: HealthService,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    if (!this.config.METRICS_ENABLED) {
      throw new NotFoundException();
    }

    const memory = process.memoryUsage();
    const lines: string[] = [];

    const gauge = (name: string, help: string, value: number, labels = ''): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
    };

    gauge('velnox_build_info', 'Build metadata, always 1.', 1,
      `{version="${this.config.VELNOX_VERSION}",commit="${this.config.VELNOX_BUILD_COMMIT}"}`);
    gauge('velnox_uptime_seconds', 'Seconds since this API process started.', this.health.uptimeSeconds());
    gauge('velnox_process_resident_memory_bytes', 'Resident set size.', memory.rss);
    gauge('velnox_process_heap_used_bytes', 'Heap in use.', memory.heapUsed);

    try {
      const counts = await this.queue.counts();
      lines.push(
        '# HELP velnox_queue_jobs Jobs in the system queue by state.',
        '# TYPE velnox_queue_jobs gauge',
      );
      for (const [state, value] of Object.entries(counts)) {
        lines.push(`velnox_queue_jobs{queue="system",state="${state}"} ${value}`);
      }
    } catch {
      // Redis unavailable. Report that as a metric rather than failing the
      // scrape, so the gap is visible in the monitoring rather than silent.
      gauge('velnox_queue_reachable', 'Whether the queue could be read during this scrape.', 0);
    }

    return `${lines.join('\n')}\n`;
  }
}
