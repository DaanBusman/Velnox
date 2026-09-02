import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, TokenService, RateLimitService],
  exports: [AuthService, SessionService, TokenService, RateLimitService],
})
export class AuthModule {}
