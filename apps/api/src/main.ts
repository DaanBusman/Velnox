import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadApiConfig, secretValues } from '@velnox/config';
import { API_PREFIX, rootRedactor } from '@velnox/shared';
import { AppModule } from './app.module';
import { createRootLogger, NestPinoLogger } from './common/logger';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CsrfMiddleware } from './common/csrf.middleware';
import cookieParser from 'cookie-parser';

async function bootstrap(): Promise<void> {
  // Configuration first: a bad value must stop the process before anything binds
  // a port or opens a connection.
  const config = loadApiConfig();

  // Teach the redactor the configured secrets before the first log line, so that
  // value-based redaction covers them too and not only runtime-generated ones.
  for (const secret of secretValues(config)) rootRedactor.remember(secret);

  const logger = createRootLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV !== 'production',
    base: { service: 'api', version: config.VELNOX_VERSION },
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new NestPinoLogger(logger),
    // The browser talks to Next.js, which proxies to this service over the
    // internal network. Nothing needs cross-origin access, so nothing gets it.
    cors: false,
  });

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const requestContext = new RequestContextMiddleware(logger);
  app.use(requestContext.handle);

  // Cookies carry the session; the CSRF check runs before any route so a
  // state-changing request cannot slip past it.
  app.use(cookieParser());
  app.use(new CsrfMiddleware().handle);

  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });

  app.useGlobalFilters(new AllExceptionsFilter(logger, config.NODE_ENV !== 'production'));
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('Velnox API')
    .setDescription(
      'Self-hosted MSP management platform for Proxmox VE fleets.\n\n' +
        'Errors carry a machine-readable `code`; the frontend renders the message from its ' +
        'locale catalogue. Velnox is free software under the AGPLv3 — see /api/v1/system/source.',
    )
    .setVersion(config.VELNOX_VERSION)
    .setLicense('AGPL-3.0-or-later', 'https://www.gnu.org/licenses/agpl-3.0.txt')
    .addTag('health', 'Liveness and readiness')
    .addTag('system', 'Installation information and licence compliance')
    .build();

  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi), {
    customSiteTitle: 'Velnox API',
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.API_PORT, '0.0.0.0');

  logger.info(
    {
      port: config.API_PORT,
      environment: config.NODE_ENV,
      version: config.VELNOX_VERSION,
      commit: config.VELNOX_BUILD_COMMIT,
    },
    'Velnox API listening',
  );

}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this path uses the
  // console deliberately. It is the only place in the API that does.
   
  console.error(
    rootRedactor.text(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  process.exit(1);
});
