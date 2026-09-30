import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { ClusterFilesController } from './cluster-files.controller';
import { ClusterSshService } from './cluster-ssh.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

/** The ISO library, and the files and SSH access on clusters it moves them to and from. */
@Module({
  // AuthModule for the secret store: setting SSH up writes an encrypted key.
  imports: [AuthModule, JobsModule],
  controllers: [LibraryController, ClusterFilesController],
  providers: [LibraryService, ClusterSshService],
})
export class LibraryModule {}
