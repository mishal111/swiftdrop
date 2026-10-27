import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PARCEL_SIZES,
  PARCEL_STATUSES,
  type ParcelSize,
  type ParcelStatus,
} from '@swiftdrop/contracts';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const PHONE = /^\+?[0-9]{9,15}$/;

/** Booking payload shared by customer bookings (M3) and merchant API orders (M5). */
export class ParcelDetailsDto {
  @ApiProperty() @IsString() @Length(2, 100) senderName: string;
  @ApiProperty({ example: '+94771234567' }) @Matches(PHONE) senderPhone: string;
  @ApiProperty() @IsString() @Length(5, 200) pickupAddress: string;
  @ApiProperty({ example: 'colombo' }) @IsString() @Length(2, 80) pickupCity: string;

  @ApiProperty() @IsString() @Length(2, 100) recipientName: string;
  @ApiProperty() @Matches(PHONE) recipientPhone: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() recipientEmail?: string;
  @ApiProperty() @IsString() @Length(5, 200) dropoffAddress: string;
  @ApiProperty({ example: 'kandy' }) @IsString() @Length(2, 80) dropoffCity: string;

  @ApiProperty({ enum: PARCEL_SIZES }) @IsIn(PARCEL_SIZES) size: ParcelSize;
  @ApiProperty({ example: 1.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  weightKg: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/** Full parcel as seen by its owner / staff. */
export class ParcelDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'SD123456789' }) trackingNumber: string;
  @ApiProperty({ enum: PARCEL_STATUSES }) status: ParcelStatus;
  @ApiProperty() senderName: string;
  @ApiProperty() pickupAddress: string;
  @ApiProperty() pickupCity: string;
  @ApiProperty() recipientName: string;
  @ApiProperty() dropoffAddress: string;
  @ApiProperty() dropoffCity: string;
  @ApiProperty({ enum: PARCEL_SIZES }) size: ParcelSize;
  @ApiProperty() weightKg: number;
  @ApiProperty() feeCents: number;
  @ApiProperty() currency: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({ nullable: true }) deliveredAt: Date | null;
}

export class StatusHistoryItemDto {
  @ApiProperty({ enum: PARCEL_STATUSES }) status: ParcelStatus;
  @ApiProperty() at: Date;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'failure reason code only (public safe)',
  })
  reason: string | null;
}

/** PUBLIC tracking view — NO names, phone numbers, full addresses or internal notes. */
export class PublicTrackingDto {
  @ApiProperty() trackingNumber: string;
  @ApiProperty({ enum: PARCEL_STATUSES }) status: ParcelStatus;
  @ApiProperty({ example: 'colombo' }) originCity: string;
  @ApiProperty({ example: 'kandy' }) destinationCity: string;
  @ApiProperty({ type: [StatusHistoryItemDto] }) history: StatusHistoryItemDto[];
  @ApiProperty() updatedAt: Date;
}
