/**
 * apps/api/src/seed-admin.ts
 *
 * 种子脚本（幂等）：写入角色/权限与初始管理员账号。
 * 运行：`npm run seed -w @shaping-memory/api`。可反复执行，不会产生重复行。
 */
import './env';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { createDb, permissions, rolePermissions, roles, users } from '@shaping-memory/db';
import { loadConfig } from '@shaping-memory/config';

const PERMS_BY_ROLE: Record<string, readonly string[]> = {
  admin: ['photo:read', 'photo:write', 'photo:delete'],
  editor: ['photo:read', 'photo:write'],
  viewer: ['photo:read'],
};

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  // 角色 + 权限 + 映射（幂等）
  for (const [roleId, perms] of Object.entries(PERMS_BY_ROLE)) {
    await db.insert(roles).values({ id: roleId, name: roleId }).onConflictDoNothing();
    for (const perm of perms) {
      await db.insert(permissions).values({ id: perm, name: perm }).onConflictDoNothing();
      await db.insert(rolePermissions).values({ roleId, permissionId: perm }).onConflictDoNothing();
    }
  }

  // 管理员账号（幂等：重复执行就刷新密码哈希）
  const userId = 'u_' + createHash('sha1').update(config.ADMIN_USERNAME).digest('hex').slice(0, 16);
  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
  await db
    .insert(users)
    .values({ id: userId, username: config.ADMIN_USERNAME, passwordHash, roleId: 'admin' })
    .onConflictDoUpdate({ target: users.username, set: { passwordHash } });

  // eslint-disable-next-line no-console
  console.log(`[seed] 角色/权限已就绪，管理员 ${config.ADMIN_USERNAME} 可用`);
}

void main();