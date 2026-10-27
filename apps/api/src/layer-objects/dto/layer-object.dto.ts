import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { LAYER_OBJECT_TYPES, LayerObjectType } from '@deep-zoom/shared-types';
import { IsObjectIdEach } from '../../common/validators/is-object-id.validator';

/**
 * The `geometry`/`style`/`metadata` bodies are validated structurally here and
 * then deeply validated per object type by `GeometryValidationService`, which
 * owns the discriminated-union rules. Keeping the DTO loose (plain object) and
 * the deep check in one dedicated service avoids duplicating the union in
 * decorators, which class-validator cannot express cleanly.
 */
export class CreateLayerObjectDto {
  @ApiProperty({ enum: LAYER_OBJECT_TYPES })
  @IsIn(LAYER_OBJECT_TYPES)  type!: LayerObjectType;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Geometry in original-image pixel coordinates' })
  @IsObject()
  geometry!: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  zIndex?: number;
}

export class UpdateLayerObjectDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  geometry?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  zIndex?: number;
}

export class ReorderObjectsDto {
  @ApiProperty({
    type: [String],
    description: 'Object ids in the desired ascending zIndex order',
  })
  @IsArray()
  @IsString({ each: true })
  @IsObjectIdEach()
  orderedObjectIds!: string[];
}

export class LayerObjectBatchDto {
  @ApiProperty({ type: [CreateLayerObjectDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateLayerObjectDto)
  objects!: CreateLayerObjectDto[];
}
