import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ImageLayer as ImageLayerDto } from '@deep-zoom/shared-types';
import { ImageLayer, ImageLayerDocument } from './schemas/image-layer.schema';
import { LayerObject, LayerObjectDocument } from '../layer-objects/schemas/layer-object.schema';
import { ImageAsset, ImageAssetDocument } from '../images/schemas/image-asset.schema';
import { ApplicationError } from '../common/errors/application.error';

@Injectable()
export class LayersService {
  constructor(
    @InjectModel(ImageLayer.name)
    private readonly layerModel: Model<ImageLayerDocument>,
    @InjectModel(LayerObject.name)
    private readonly objectModel: Model<LayerObjectDocument>,
    @InjectModel(ImageAsset.name)
    private readonly imageModel: Model<ImageAssetDocument>,
  ) {}

  async assertImageExists(imageId: string): Promise<Types.ObjectId> {
    this.assertObjectId(imageId, 'INVALID_IMAGE_ID');
    const objectId = new Types.ObjectId(imageId);
    const exists = await this.imageModel.exists({ _id: objectId }).exec();
    if (!exists) {
      throw ApplicationError.notFound('IMAGE_NOT_FOUND', 'Image not found');
    }
    return objectId;
  }

  /**
   * Loads a layer and verifies it belongs to `imageId`. This is the single
   * ownership gate used by every layer/object mutation so a client can never
   * touch a layer that belongs to a different image.
   */
  async findOwnedLayer(imageId: string, layerId: string): Promise<ImageLayerDocument> {
    const imageObjectId = await this.assertImageExists(imageId);
    await this.findLayerById(layerId);

    const layer = await this.layerModel
      .findOne({ _id: new Types.ObjectId(layerId), imageAssetId: imageObjectId })
      .exec();
    if (!layer) {
      throw ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer not found for this image');
    }
    return layer;
  }

  async findLayerById(layerId: string): Promise<ImageLayerDocument> {
    this.assertObjectId(layerId, 'INVALID_LAYER_ID');
    const layer = await this.layerModel.findById(layerId).exec();
    if (!layer) {
      throw ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer not found');
    }
    return layer;
  }

  async list(imageId: string): Promise<ImageLayerDto[]> {
    const imageObjectId = await this.assertImageExists(imageId);
    const layers = await this.layerModel
      .find({ imageAssetId: imageObjectId })
      .sort({ zIndex: 1, createdAt: 1 })
      .exec();
    return layers.map((layer) => this.toDto(layer));
  }

  async create(
    imageId: string,
    payload: { name: string; visible?: boolean; locked?: boolean; zIndex?: number },
  ): Promise<ImageLayerDto> {
    const imageObjectId = await this.assertImageExists(imageId);

    let zIndex = payload.zIndex;
    if (zIndex === undefined) {
      // Append on top of the existing stack.
      const highest = await this.layerModel
        .findOne({ imageAssetId: imageObjectId })
        .sort({ zIndex: -1 })
        .select('zIndex')
        .exec();
      zIndex = highest ? highest.zIndex + 1 : 0;
    }

    const layer = await this.layerModel.create({
      imageAssetId: imageObjectId,
      name: payload.name.trim(),
      visible: payload.visible ?? true,
      locked: payload.locked ?? false,
      zIndex,
    });

    return this.toDto(layer);
  }

  async update(
    layerId: string,
    payload: { name?: string; visible?: boolean; locked?: boolean; zIndex?: number },
    imageId?: string,
  ): Promise<ImageLayerDto> {
    const layer = imageId
      ? await this.findOwnedLayer(imageId, layerId)
      : await this.findLayerById(layerId);

    const update: Record<string, unknown> = {};
    if (payload.name !== undefined) update.name = payload.name.trim();
    if (payload.visible !== undefined) update.visible = payload.visible;
    if (payload.locked !== undefined) update.locked = payload.locked;
    if (payload.zIndex !== undefined) update.zIndex = payload.zIndex;

    if (Object.keys(update).length === 0) {
      throw ApplicationError.badRequest('EMPTY_UPDATE', 'No updatable fields were provided');
    }

    const updated = await this.layerModel
      .findByIdAndUpdate(layer._id, { $set: update }, { new: true, runValidators: true })
      .exec();
    if (!updated) {
      throw ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer not found');
    }
    return this.toDto(updated);
  }

  async remove(layerId: string, imageId?: string): Promise<void> {
    const layer = imageId
      ? await this.findOwnedLayer(imageId, layerId)
      : await this.findLayerById(layerId);

    // Objects cannot outlive their layer; Mongo has no cascade.
    await this.objectModel.deleteMany({ layerId: layer._id }).exec();
    await this.layerModel.deleteOne({ _id: layer._id }).exec();
  }

  async assertLayerBelongsToImage(layerId: Types.ObjectId, imageId: Types.ObjectId): Promise<void> {
    const exists = await this.layerModel.exists({ _id: layerId, imageAssetId: imageId }).exec();
    if (!exists) {
      throw ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer not found for this image');
    }
  }

  toDto(layer: ImageLayerDocument): ImageLayerDto {
    return {
      _id: layer._id.toString(),
      imageAssetId: layer.imageAssetId.toString(),
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      zIndex: layer.zIndex,
      createdAt: (layer.createdAt ?? new Date()).toISOString(),
      updatedAt: (layer.updatedAt ?? new Date()).toISOString(),
    };
  }

  assertObjectId(value: string, code: string): void {
    if (!/^[0-9a-fA-F]{24}$/.test(value) || !Types.ObjectId.isValid(value)) {
      throw ApplicationError.badRequest(code, 'Invalid id format');
    }
  }
}
