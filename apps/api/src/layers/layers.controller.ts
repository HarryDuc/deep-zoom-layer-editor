import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { LayersService } from './layers.service';
import { CreateLayerDto, LayerResponseDto, UpdateLayerDto } from './dto/layer.dto';

@ApiTags('layers')
@Controller()
export class LayersController {
  constructor(private readonly layersService: LayersService) {}

  @Get('images/:imageId/layers')
  @ApiOperation({ summary: 'List layers of an image' })
  @ApiParam({ name: 'imageId' })
  async list(@Param('imageId') imageId: string): Promise<LayerResponseDto[]> {
    return this.layersService.list(imageId);
  }

  @Post('images/:imageId/layers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a layer' })
  @ApiOkResponse({ type: LayerResponseDto })
  async create(
    @Param('imageId') imageId: string,
    @Body() body: CreateLayerDto,
  ): Promise<LayerResponseDto> {
    return this.layersService.create(imageId, body);
  }

  @Patch('layers/:layerId')
  @ApiOperation({ summary: 'Update layer properties' })
  @ApiOkResponse({ type: LayerResponseDto })
  async update(
    @Param('layerId') layerId: string,
    @Body() body: UpdateLayerDto,
  ): Promise<LayerResponseDto> {
    return this.layersService.update(layerId, body);
  }

  @Delete('layers/:layerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a layer and its objects' })
  async remove(@Param('layerId') layerId: string): Promise<void> {
    await this.layersService.remove(layerId);
  }
}
