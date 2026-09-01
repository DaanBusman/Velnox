import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { QueueService } from './queue.service';

/**
 * Shared infrastructure clients. Global because health, system and every future
 * feature module needs them, and threading them through imports adds noise
 * without adding a boundary that means anything.
 */
@Global()
@Module({
  providers: [PrismaService, RedisService, QueueService],
  exports: [PrismaService, RedisService, QueueService],
})
export class InfrastructureModule {}
