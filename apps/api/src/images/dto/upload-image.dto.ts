import { ApiProperty } from '@nestjs/swagger';
import { ImageStatus } from '@deep-zoom/shared-types';

export class CreateImageDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'JPEG or PNG image file',
  })
  file!: unknown;
}

export class ImageStatusQueryDto {
  // Placeholder: status polling takes no body. Kept for Swagger documentation.
  @ApiProperty({ required: false })
  _?: string;
}

export function isTerminalStatus(status: ImageStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}
