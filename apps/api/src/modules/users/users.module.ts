import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersAdminController } from './users-admin.controller';
import { UsersService } from './users.service';
import { UserAdminService } from './user-admin.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, UsersAdminController],
  providers: [UsersService, UserAdminService],
  exports: [UsersService],
})
export class UsersModule {}
