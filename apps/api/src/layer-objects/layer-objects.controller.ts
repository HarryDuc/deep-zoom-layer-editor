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
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { LayerObject as LayerObjectDto } from '@deep-zoom/shared-types';
import { LayerObjectsService } from './layer-objects.service';
import {
  CreateLayerObjectDto,
  ReorderObjectsDto,
  UpdateLayerObjectDto,
} from './dto/layer-object.dto';

@ApiTags('layer-objects')
@Controller()
export class LayerObjectsController {
  constructor(private readonly layerObjectsService: LayerObjectsService) {}

  @Post('layers/:layerId/objects')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a layer object',
    description:
      'Geometry must be expressed in original-image pixel coordinates and is validated per object type.',
  })
  @ApiParam({ name: 'layerId' })
  async create(
    @Param('layerId') layerId: string,
    @Body() body: CreateLayerObjectDto,
  ): Promise<LayerObjectDto> {
    return this.layerObjectsService.create(layerId, body);
  }

  @Get('layers/:layerId/objects')
  @ApiOperation({ summary: 'List objects of a layer' })
  @ApiParam({ name: 'layerId' })
  async list(@Param('layerId') layerId: string): Promise<LayerObjectDto[]> {
    return this.layerObjectsService.list(layerId);
  }

  @Patch('layers/:layerId/objects/order')
  @ApiOperation({ summary: 'Reorder objects inside a layer' })
  @ApiParam({ name: 'layerId' })
  async reorder(
    @Param('layerId') layerId: string,
    @Body() body: ReorderObjectsDto,
  ): Promise<LayerObjectDto[]> {
    return this.layerObjectsService.reorder(layerId, body.orderedObjectIds);
  }

  @Patch('layer-objects/:objectId')
  @ApiOperation({ summary: 'Update a layer object' })
  @ApiParam({ name: 'objectId' })
  async update(
    @Param('objectId') objectId: string,
    @Body() body: UpdateLayerObjectDto,
  ): Promise<LayerObjectDto> {
    return this.layerObjectsService.update(objectId, body);
  }

  @Delete('layer-objects/:objectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a layer object' })
  @ApiParam({ name: 'objectId' })
  async remove(@Param('objectId') objectId: string): Promise<void> {
    await this.layerObjectsService.remove(objectId);
  }
}
