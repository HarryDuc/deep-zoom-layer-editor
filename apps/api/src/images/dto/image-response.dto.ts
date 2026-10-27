import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ImageStatus } from '@deep-zoom/shared-types';

export class ImageAssetResponseDto {
  @ApiProperty()
  _id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  originalFilename!: string;

  @ApiPropertyOptional()
  width?: number;

  @ApiPropertyOptional()
  height?: number;

  @ApiProperty()
  fileSize!: number;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty({ enum: ['PROCESSING', 'COMPLETED', 'FAILED'] })
  status!: ImageStatus;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class ImageStatusResponseDto {
  @ApiProperty()
  imageId!: string;

  @ApiProperty({ enum: ['PROCESSING', 'COMPLETED', 'FAILED'] })
  status!: ImageStatus;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiPropertyOptional()
  width?: number;

  @ApiPropertyOptional()
  height?: number;

  @ApiProperty()
  updatedAt!: string;
}

export class OverlayAssetResponseDto {
  @ApiProperty()
  _id!: string;

  @ApiProperty()
  imageAssetId!: string;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;

  @ApiProperty()
  fileSize!: number;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  createdAt!: string;
}
