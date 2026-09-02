import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { SecretStoreService } from './secret-store.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    MfaService,
    SecretStoreService,
    SessionService,
    TokenService,
    RateLimitService,
  ],
  exports: [AuthService, MfaService, SecretStoreService, SessionService, TokenService, RateLimitService],
})
export class AuthModule {}
