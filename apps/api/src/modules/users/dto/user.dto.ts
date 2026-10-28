import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLES, type Role } from '@swiftdrop/contracts';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';

/** Public shape of a user. NEVER include passwordHash or sessions. */
export class UserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiProperty({ enum: ROLES }) role: Role;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: Date;
}

export class UpdateMeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 100) name?: string;
  @ApiPropertyOptional({ example: '+94771234567' })
  @IsOptional()
  @Matches(/^\+?[0-9]{9,15}$/)
  phone?: string;
}

/** Admin creates staff accounts (couriers, dispatchers, admins). */
export class AdminCreateUserDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @Length(2, 100) name: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role: Role;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{9,15}$/) phone?: string;
}

export class AdminUpdateUserDto {
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PageMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
  @ApiProperty() total: number;
}

export class PaginatedUsersDto {
  @ApiProperty({ type: [UserDto] }) data: UserDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class ListUsersQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}
