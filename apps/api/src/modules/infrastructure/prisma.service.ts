import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@velnox/db';
import type { ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';

/**
 * The API's database client.
 *
 * A wrapper rather than a subclass of PrismaClient: from Phase 3 the client is
 * built with the tenancy extension attached, and `$extends` returns a different
 * type than the base client. Owning an instance instead of inheriting from one
 * keeps that change local to `createPrismaClient`.
 *
 * Connection is established at startup so a misconfigured DATABASE_URL fails the
 * container's start rather than the first request that happens to need it.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = createPrismaClient({
      databaseUrl: config.DATABASE_URL,
      logQueries: false,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
