import { Global, Module } from '@nestjs/common';
import { loadApiConfig, type ApiConfig } from '@velnox/config';

/**
 * Configuration is loaded and validated exactly once, at module construction.
 * If anything is missing or malformed the process fails to start with a message
 * naming every offending variable — see packages/config.
 */
export const API_CONFIG = 'API_CONFIG';

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      useFactory: (): ApiConfig => loadApiConfig(),
    },
  ],
  exports: [API_CONFIG],
})
export class ConfigModule {}
