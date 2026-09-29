/**
 * apps/api/src/admin/users.service.ts
 *
 * 账号管理：列表 / 新建 / 改角色与改密码 / 删除。
 * 密码只存 bcrypt 哈希（与登录校验同一套），返回值里绝不含哈希。
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { asc, eq, sql } from 'drizzle-orm';
import { roles, users } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** 对外账号形状（与前端 SDK 的 AdminUser 一一对应） */
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

export interface UserCreateDto {
  username: string;
  password: string;
  role: string;
}

export interface UserPatchDto {
  role?: string;
  /** 只传新密码；不传即不改 */
  password?: string;
}

/** 密码最短长度：后台能直接建账号，太短的密码等于没有密码 */
const MIN_PASSWORD_LEN = 6;

/** 审计里排除的账号数：后台必须至少留一个 admin，否则谁也进不来了 */
const KEEP_ADMIN_COUNT = 1;

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<AdminUser[]> {
    const rows = await this.db.select().from(users).orderBy(asc(users.createdAt));
    return rows.map((row) => this.toApi(row));
  }

  async create(dto: UserCreateDto): Promise<AdminUser> {
    const username = dto.username?.trim();
    if (!username) throw new BadRequestException('用户名不能为空');
    this.assertPassword(dto.password);
    const role = await this.requireRole(dto.role);

    if (await this.findByName(username)) throw new ConflictException('该用户名已存在');

    // id 由用户名派生（与 seed-admin 同一规则）：确定性、可读，且不必引入额外序列
    const id = 'u_' + createHash('sha1').update(username).digest('hex').slice(0, 16);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    await this.db.insert(users).values({ id, username, passwordHash, roleId: role });
    return { id, username, role, createdAt: new Date().toISOString() };
  }

  /** 改角色 / 重置密码（两者可单独改）；operator 是当前操作者的用户名 */
  async update(id: string, dto: UserPatchDto, operator: string): Promise<AdminUser> {
    const row = await this.requireUser(id);
    const sets: { roleId?: string; passwordHash?: string } = {};

    if (dto.role !== undefined) {
      const role = await this.requireRole(dto.role);
      // 把自己降级出 admin 会立刻失去后台入口，属于误操作，直接拦下
      if (row.username === operator && role !== 'admin') {
        throw new BadRequestException('不能修改自己的角色');
      }
      if (row.roleId === 'admin' && role !== 'admin') await this.assertNotLastAdmin();
      sets.roleId = role;
    }
    if (dto.password !== undefined) {
      this.assertPassword(dto.password);
      sets.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    if (Object.keys(sets).length > 0) {
      await this.db.update(users).set(sets).where(eq(users.id, id));
    }
    return this.toApi(await this.requireUser(id));
  }

  async remove(id: string, operator: string): Promise<void> {
    const row = await this.requireUser(id);
    if (row.username === operator) throw new BadRequestException('不能删除当前登录的账号');
    if (row.roleId === 'admin') await this.assertNotLastAdmin();
    await this.db.delete(users).where(eq(users.id, id));
  }

  /* ----------------------------------------------------------------------
   * 内部工具
   * -------------------------------------------------------------------- */

  private async findByName(username: string) {
    return this.db.query.users.findFirst({ where: eq(users.username, username) });
  }

  private async requireUser(id: string) {
    const row = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!row) throw new NotFoundException('账号不存在');
    return row;
  }

  /** 角色必须真实存在于 roles 表，否则会写出一个永远登录不上、也判不了权限的账号 */
  private async requireRole(role: string): Promise<string> {
    const value = role?.trim();
    if (!value) throw new BadRequestException('角色不能为空');
    const row = await this.db.query.roles.findFirst({ where: eq(roles.id, value) });
    if (!row) throw new BadRequestException(`角色「${value}」不存在`);
    return value;
  }

  /**
   * 拦住「让最后一个管理员消失」：删完 / 降级完之后没人能再进后台，只能改库恢复。
   * 调用点传入的都是「当前确实是 admin」的那一行，因此它的计数必然包含自己 ——
   * 总数不大于 1 就说明它是唯一的管理员。
   */
  private async assertNotLastAdmin(): Promise<void> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.roleId, 'admin'));
    if (Number(row?.n ?? 0) <= KEEP_ADMIN_COUNT) {
      throw new BadRequestException('系统至少需要保留一个管理员账号');
    }
  }

  private assertPassword(password: string): void {
    if (!password || password.length < MIN_PASSWORD_LEN) {
      throw new BadRequestException(`密码至少 ${MIN_PASSWORD_LEN} 位`);
    }
  }

  private toApi(row: { id: string; username: string; roleId: string; createdAt: Date }): AdminUser {
    return { id: row.id, username: row.username, role: row.roleId, createdAt: row.createdAt.toISOString() };
  }
}