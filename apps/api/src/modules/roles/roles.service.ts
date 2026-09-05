import { Injectable } from '@nestjs/common';
import { PERMISSIONS, isPermission, type Permission } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * Roles, as they exist in this installation.
 *
 * The catalogue in `@velnox/shared` says which permissions can exist; these rows
 * say which ones each role actually holds. Reading from the database rather than
 * from the catalogue matters — a role edited later must be reported as it is,
 * not as it was seeded.
 */

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  mspOnly: boolean;
  /** Only permissions this build still recognises. */
  permissions: Permission[];
  /** Permission strings stored against the role that this build does not know. */
  unknownPermissions: string[];
  assignmentCount: number;
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<RoleSummary[]> {
    const roles = await this.prisma.client.role.findMany({
      orderBy: [{ name: 'asc' }],
      include: {
        permissions: true,
        _count: { select: { assignments: true } },
      },
    });

    return roles.map((role) => {
      const stored = role.permissions.map((entry) => entry.permission);

      return {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        mspOnly: role.mspOnly,
        permissions: stored.filter((permission): permission is Permission =>
          isPermission(permission),
        ),
        /*
         * Reported rather than hidden.
         *
         * A row naming a permission this build does not have is either a
         * downgrade or a bad migration. The guard already ignores such rows when
         * building a principal, so they grant nothing — but silently dropping
         * them from this list would hide the fact that the database and the code
         * disagree.
         */
        unknownPermissions: stored.filter((permission) => !isPermission(permission)),
        assignmentCount: role._count.assignments,
      };
    });
  }

  /** The full catalogue, so the interface can show what a role does not have. */
  catalogue(): Permission[] {
    return [...Object.values(PERMISSIONS)].sort();
  }
}
