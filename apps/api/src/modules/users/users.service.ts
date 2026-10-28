import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type Role } from '@swiftdrop/contracts';
import { Prisma, type User } from '@swiftdrop/db';
import * as argon2 from 'argon2';
import { JwtAuthGuard, type AuthUser } from '../../common/auth';
import { AppError, notFound } from '../../common/errors/app-error';
import { paginated } from '../../common/pagination/pagination';
import { PrismaService } from '../../infra/prisma';
import { AuditService } from '../audit';
import type {
  AdminCreateUserDto,
  AdminUpdateUserDto,
  ListUsersQuery,
  UpdateMeDto,
  UserDto,
} from './dto/user.dto';

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  /** Plain password — hashed here with argon2id. Omit for OAuth-only users. */
  password?: string;
  phone?: string;
}

/**
 * PUBLIC SERVICE (exported) — other modules may call: findById, findByEmail, createUser, toDto.
 * Owner: M2.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  }

  async getMe(userId: string): Promise<UserDto> {
    const user = await this.findById(userId);
    if (!user) throw notFound('User');
    return this.toDto(user);
  }

  /** Used by auth registration (M2) and merchant registration (M5). */
  async createUser(input: CreateUserInput): Promise<User> {
    return this.insertUser(this.prisma, input);
  }

  async updateMe(userId: string, dto: UpdateMeDto): Promise<UserDto> {
    const user = await this.findById(userId);
    if (!user) throw notFound('User');

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    return this.toDto(updated);
  }

  async adminList(q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {};
    if (q.role) {
      where.role = q.role;
    }
    if (q.search) {
      const s = q.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip: q.skip,
        take: q.take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return paginated(
      users.map((u) => this.toDto(u)),
      total,
      q,
    );
  }

  async adminCreate(dto: AdminCreateUserDto, actor: AuthUser): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await this.insertUser(tx, dto);
      if (created.role === 'COURIER') {
        await tx.courierProfile.create({ data: { userId: created.id } });
      }
      await this.audit.record(
        {
          actor: { id: actor.id, role: actor.role },
          action: 'user.created',
          entityType: 'User',
          entityId: created.id,
          metadata: { role: created.role },
        },
        tx,
      );
      return created;
    });
    return this.toDto(user);
  }

  async adminUpdate(id: string, dto: AdminUpdateUserDto, actor: AuthUser): Promise<UserDto> {
    const user = await this.findById(id);
    if (!user) throw notFound('User');

    const roleChanged = dto.role !== undefined && dto.role !== user.role;
    const activeChanged = dto.isActive !== undefined && dto.isActive !== user.isActive;
    if (!roleChanged && !activeChanged) return this.toDto(user);

    // An admin must not lock themselves out (demote or deactivate their own account).
    if (id === actor.id) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        'You cannot change your own role or status',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { role: dto.role, isActive: dto.isActive },
      });

      // Couriers need a profile for dispatch (M7), whether created as COURIER or promoted later.
      if (roleChanged && u.role === 'COURIER') {
        await tx.courierProfile.upsert({
          where: { userId: id },
          create: { userId: id },
          update: {},
        });
      }

      // Deactivation ends every session. (A role change needs nothing: refresh re-reads the role.)
      if (activeChanged && !u.isActive) {
        await tx.refreshSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await this.audit.record(
        {
          actor: { id: actor.id, role: actor.role },
          action:
            roleChanged && activeChanged
              ? 'user.updated'
              : roleChanged
                ? 'user.role_changed'
                : 'user.status_changed',
          entityType: 'User',
          entityId: id,
          metadata: {
            previousRole: user.role,
            newRole: u.role,
            previousIsActive: user.isActive,
            newIsActive: u.isActive,
          },
        },
        tx,
      );
      return u;
    });

    // Make JwtAuthGuard re-read the new role/status on the user's next request.
    JwtAuthGuard.invalidateUser(id);

    return this.toDto(updated);
  }

  /** Normalises the email, hashes the password and maps a duplicate email to EMAIL_TAKEN. */
  private async insertUser(db: Prisma.TransactionClient, input: CreateUserInput): Promise<User> {
    const email = input.email.toLowerCase().trim();
    if (await db.user.findUnique({ where: { email } })) throw emailTaken();

    const passwordHash = input.password
      ? await argon2.hash(input.password, { type: argon2.argon2id })
      : null;

    try {
      return await db.user.create({
        data: {
          email,
          name: input.name.trim(),
          phone: input.phone?.trim() || null,
          role: input.role,
          passwordHash,
        },
      });
    } catch (e) {
      // Two sign-ups with the same email at once: the unique index catches the loser.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw emailTaken();
      }
      throw e;
    }
  }

  toDto(u: User): UserDto {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      role: u.role,
      isActive: u.isActive,
      createdAt: u.createdAt,
    };
  }
}

const emailTaken = () =>
  new AppError(
    ERROR_CODES.EMAIL_TAKEN,
    'An account with this email already exists',
    HttpStatus.CONFLICT,
  );
