import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Request, Response } from 'express';
import {
  ImageAssetResponseDto,
  ImageStatusResponseDto,
  OverlayAssetResponseDto,
} from './dto/image-response.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { ImagesService, UploadedFileLike } from './images.service';
import { StorageService } from '../storage/storage.service';
import { ApplicationError } from '../common/errors/application.error';
import {
  IMAGE_UPLOAD_FILTER,
  OVERLAY_UPLOAD_FILTER,
} from '../common/multer/upload-options';

class UploadImageQueryDto {
  @ApiPropertyOptional({ description: 'Display name; defaults to the filename' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;
}

/**
 * Absolute origin (`scheme://host[:port]`) the current request arrived on.
 * Honours `X-Forwarded-Proto` / `X-Forwarded-Host` so the descriptor stays
 * correct behind a reverse proxy.
 */
function requestOrigin(req: Request): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() ||
    req.protocol ||
    'http';
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() ||
    req.get('host') ||
    'localhost';
  return `${proto}://${host}`;
}

@ApiTags('images')
@Controller('images')
export class ImagesController {
  constructor(
    private readonly imagesService: ImagesService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a JPEG/PNG image',
    description:
      'Stores the original, creates the asset as PROCESSING and returns immediately. DZI generation continues in the background.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
      },
    },
  })
  @ApiOkResponse({ type: ImageAssetResponseDto })
  @UseInterceptors(FileInterceptor('file', { fileFilter: IMAGE_UPLOAD_FILTER }))
  async upload(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Query() query: UploadImageQueryDto,
  ): Promise<ImageAssetResponseDto> {
    if (!file) {
      throw ApplicationError.badRequest('FILE_REQUIRED', 'An image file is required');
    }
    return this.imagesService.createFromUpload(file, query.name);
  }

  @Get()
  @ApiOperation({ summary: 'List uploaded images, newest first' })
  async list(@Query() query: PaginationQueryDto) {
    return this.imagesService.list(query.page, query.limit);
  }

  @Get(':imageId')
  @ApiOperation({ summary: 'Get image metadata' })
  @ApiParam({ name: 'imageId' })
  async findOne(@Param('imageId') imageId: string): Promise<ImageAssetResponseDto> {
    return this.imagesService.getDto(imageId);
  }

  @Get(':imageId/status')
  @ApiOperation({ summary: 'Poll DZI processing status' })
  async status(@Param('imageId') imageId: string): Promise<ImageStatusResponseDto> {
    return this.imagesService.getStatus(imageId);
  }

  @Get(':imageId/dzi')
  @ApiOperation({
    summary: 'Serve the DZI descriptor',
    description:
      "Deep Zoom XML whose 'Url' attribute is an absolute URL pointing at this API's tile endpoint.",
  })
  async dzi(
    @Param('imageId') imageId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    // Absolute tile URLs are built from the request's own origin so the
    // descriptor works for any host the API is reached on (localhost, LAN IP,
    // reverse proxy) without extra configuration.
    const { xml, etag } = await this.imagesService.getDziDescriptor(
      imageId,
      requestOrigin(req),
    );

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('ETag', etag);
    return xml;
  }

  @Get(':imageId/tiles/:level/:tile')
  @ApiOperation({ summary: 'Serve a single DZI tile' })
  async tile(
    @Param('imageId') imageId: string,
    @Param('level') level: string,
    @Param('tile') tile: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // Rebuilt from validated route params only; never from a raw query path.
    const resolved = await this.imagesService.resolveTileFile(imageId, `${level}/${tile}`);

    res.setHeader('Content-Type', resolved.contentType);
    res.setHeader('Content-Length', String(resolved.size));
    // Tiles for an asset are immutable once generated.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return new StreamableFile(this.storage.createReadStream(resolved.absolutePath));
  }

  @Post(':imageId/overlays')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload a PNG/WebP overlay asset' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: OverlayAssetResponseDto })
  @UseInterceptors(FileInterceptor('file', { fileFilter: OVERLAY_UPLOAD_FILTER }))
  async uploadOverlay(
    @Param('imageId') imageId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ): Promise<OverlayAssetResponseDto> {
    if (!file) {
      throw ApplicationError.badRequest('FILE_REQUIRED', 'An overlay file is required');
    }
    return this.imagesService.createOverlay(imageId, file);
  }

  @Get(':imageId/overlays/:overlayId')
  @ApiOperation({ summary: 'Serve an overlay asset' })
  async overlay(
    @Param('imageId') imageId: string,
    @Param('overlayId') overlayId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const resolved = await this.imagesService.getOverlayFile(imageId, overlayId);

    res.setHeader('Content-Type', resolved.contentType);
    res.setHeader('Content-Length', String(resolved.size));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return new StreamableFile(this.storage.createReadStream(resolved.absolutePath));
  }

  @Get(':imageId/overlays/:overlayId/dzi')
  @ApiOperation({
    summary: "Serve an overlay's Deep Zoom descriptor",
    description:
      "Deep Zoom XML for an overlay bitmap, so IMAGE layers gain real detail when zooming in.",
  })
  async overlayDzi(
    @Param('imageId') imageId: string,
    @Param('overlayId') overlayId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { xml, etag } = await this.imagesService.getOverlayDziDescriptor(
      imageId,
      overlayId,
      requestOrigin(req),
    );

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    return xml;
  }

  @Get(':imageId/overlays/:overlayId/tiles/:level/:tile')
  @ApiOperation({ summary: 'Serve a single overlay DZI tile' })
  async overlayTile(
    @Param('imageId') imageId: string,
    @Param('overlayId') overlayId: string,
    @Param('level') level: string,
    @Param('tile') tile: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const resolved = await this.imagesService.resolveOverlayTileFile(
      imageId,
      overlayId,
      `${level}/${tile}`,
    );

    res.setHeader('Content-Type', resolved.contentType);
    res.setHeader('Content-Length', String(resolved.size));
    // Overlay tiles are immutable once generated.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return new StreamableFile(this.storage.createReadStream(resolved.absolutePath));
  }

  @Delete(':imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an image and its dependent data' })
  async remove(@Param('imageId') imageId: string): Promise<void> {
    await this.imagesService.remove(imageId);
  }
}
