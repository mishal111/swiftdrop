import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import {
  AdminCreateUserDto,
  AdminUpdateUserDto,
  ListUsersQuery,
  PaginatedUsersDto,
  UpdateMeDto,
  UserDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

/** Owner: M2 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current signed-in user' })
  @ApiOkResponse({ type: UserDto })
  me(@CurrentUser() user: AuthUser) {
    return this.users.getMe(user.id);
  }

  @Patch('me')
  @ApiOkResponse({ type: UserDto })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user.id, dto);
  }
}

/** Owner: M2 — admin user management */
@ApiTags('admin')
@Controller('admin/users')
@Roles('ADMIN')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedUsersDto })
  list(@Query() q: ListUsersQuery) {
    return this.users.adminList(q);
  }

  @Post()
  @ApiOkResponse({ type: UserDto })
  create(@Body() dto: AdminCreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.adminCreate(dto, actor);
  }

  @Patch(':id')
  @ApiOkResponse({ type: UserDto })
  update(@Param('id') id: string, @Body() dto: AdminUpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.adminUpdate(id, dto, actor);
  }
}
