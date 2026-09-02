import { Global, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { loadApiConfig } from '@velnox/config';
import { createRootLogger, NestPinoLogger, ROOT_LOGGER } from './logger';

/**
 * The process logger, available for injection.
 *
 * Built from configuration once, so every service logs through the same
 * redacting sink rather than each constructing its own.
 */
export { ROOT_LOGGER };

@Global()
@Module({
  providers: [
    {
      provide: ROOT_LOGGER,
      useFactory: (): Logger => {
        const config = loadApiConfig();
        return createRootLogger({
          level: config.LOG_LEVEL,
          pretty: config.NODE_ENV !== 'production',
          base: { service: 'api', version: config.VELNOX_VERSION },
        });
      },
    },
    NestPinoLogger,
  ],
  exports: [ROOT_LOGGER, NestPinoLogger],
})
export class LoggerModule {}
