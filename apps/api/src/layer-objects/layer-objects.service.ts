import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ImageOverlayGeometry,
  LayerGeometry,
  LayerObject as LayerObjectDto,
  LayerObjectMetadata,
  LayerObjectStyle,
  LayerObjectType,
} from '@deep-zoom/shared-types';
import { LayerObject, LayerObjectDocument } from './schemas/layer-object.schema';
import { ImageLayer, ImageLayerDocument } from '../layers/schemas/image-layer.schema';
import { ImageAsset, ImageAssetDocument } from '../images/schemas/image-asset.schema';
import { OverlayAsset, OverlayAssetDocument } from '../images/schemas/overlay-asset.schema';
import {
  GeometryValidationService,
  GeometryValidationError,
} from '../common/validators/geometry-validation.service';
import { ApplicationError } from '../common/errors/application.error';

export interface CreateObjectInput {
  type: LayerObjectType;
  geometry: Record<string, unknown>;
  style?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  visible?: boolean;
  zIndex?: number;
}

export interface UpdateObjectInput {
  geometry?: Record<string, unknown>;
  style?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  visible?: boolean;
  zIndex?: number;
}

const DEFAULT_STYLE: Record<LayerObjectType, LayerObjectStyle> = {
  POLYGON: { fill: '#2563eb', fillOpacity: 0.25, stroke: '#1d4ed8', strokeWidth: 2, strokeOpacity: 1 },
  RECTANGLE: { fill: '#16a34a', fillOpacity: 0.2, stroke: '#15803d', strokeWidth: 2, strokeOpacity: 1 },
  POINT: { fill: '#dc2626', stroke: '#7f1d1d', strokeWidth: 2, radius: 8 },
  LABEL: {
    color: '#111827',
    fontSize: 32,
    fontFamily: 'system-ui, sans-serif',
    backgroundColor: '#ffffff',
    backgroundOpacity: 0.75,
  },
  IMAGE: { opacity: 1 },
};

const MAX_TEXT_LENGTH = 500;

@Injectable()
export class LayerObjectsService {
  constructor(
    @InjectModel(LayerObject.name)
    private readonly objectModel: Model<LayerObjectDocument>,
    @InjectModel(ImageLayer.name)
    private readonly layerModel: Model<ImageLayerDocument>,
    @InjectModel(ImageAsset.name)
    private readonly imageModel: Model<ImageAssetDocument>,
    @InjectModel(OverlayAsset.name)
    private readonly overlayModel: Model<OverlayAssetDocument>,
    private readonly geometryValidation: GeometryValidationService,
  ) {}

  async list(layerId: string): Promise<LayerObjectDto[]> {
    await this.requireLayer(layerId);
    const objects = await this.objectModel
      .find({ layerId: new Types.ObjectId(layerId) })
      .sort({ zIndex: 1, createdAt: 1 })
      .exec();
    return objects.map((object) => this.toDto(object));
  }

  async create(layerId: string, input: CreateObjectInput): Promise<LayerObjectDto> {
    const { layer, image } = await this.requireLayerWithImage(layerId);

    const geometry = this.validateGeometry(input.type, input.geometry, image);
    await this.assertOverlayReference(input.type, geometry, image._id);

    const style = this.normalizeStyle(input.type, input.style);
    const metadata = this.normalizeMetadata(input.type, input.metadata);

    let zIndex = input.zIndex;
    if (zIndex === undefined) {
      const highest = await this.objectModel
        .findOne({ layerId: layer._id })
        .sort({ zIndex: -1 })
        .select('zIndex')
        .exec();
      zIndex = highest ? highest.zIndex + 1 : 0;
    }

    const created = await this.objectModel.create({
      layerId: layer._id,
      type: input.type,
      geometry,
      style,
      metadata,
      visible: input.visible ?? true,
      zIndex,
    });

    return this.toDto(created);
  }

  async update(objectId: string, input: UpdateObjectInput): Promise<LayerObjectDto> {
    const existing = await this.requireObject(objectId);
    const { image } = await this.requireLayerWithImage(existing.layerId.toString());

    const update: Record<string, unknown> = {};

    if (input.geometry !== undefined) {
      const geometry = this.validateGeometry(existing.type, input.geometry, image);
      await this.assertOverlayReference(existing.type, geometry, image._id);
      update.geometry = geometry;
    }
    if (input.style !== undefined) {
      update.style = this.normalizeStyle(existing.type, input.style);
    }
    if (input.metadata !== undefined) {
      update.metadata = this.normalizeMetadata(existing.type, input.metadata);
    }
    if (input.visible !== undefined) update.visible = input.visible;
    if (input.zIndex !== undefined) update.zIndex = input.zIndex;

    if (Object.keys(update).length === 0) {
      throw ApplicationError.badRequest('EMPTY_UPDATE', 'No updatable fields were provided');
    }

    const updated = await this.objectModel
      .findByIdAndUpdate(existing._id, { $set: update }, { new: true, runValidators: true })
      .exec();
    if (!updated) {
      throw ApplicationError.notFound('OBJECT_NOT_FOUND', 'Layer object not found');
    }
    return this.toDto(updated);
  }

  async remove(objectId: string): Promise<void> {
    const existing = await this.requireObject(objectId);
    await this.objectModel.deleteOne({ _id: existing._id }).exec();
  }

  /**
   * Applies an explicit stacking order. Only objects that actually belong to
   * `layerId` are accepted; a partial list leaves unrelated objects untouched.
   */
  async reorder(layerId: string, orderedObjectIds: string[]): Promise<LayerObjectDto[]> {
    const layer = await this.requireLayer(layerId);
    const unique = new Set(orderedObjectIds);
    if (unique.size !== orderedObjectIds.length) {
      throw ApplicationError.badRequest('DUPLICATE_OBJECT_IDS', 'Object ids must be unique');
    }

    const ids = orderedObjectIds.map((id) => new Types.ObjectId(id));
    const matching = await this.objectModel
      .countDocuments({ _id: { $in: ids }, layerId: layer._id })
      .exec();
    if (matching !== ids.length) {
      throw ApplicationError.badRequest(
        'OBJECT_LAYER_MISMATCH',
        'All objects must belong to the specified layer',
      );
    }

    await this.objectModel.bulkWrite(
      ids.map((id, index) => ({
        updateOne: {
          filter: { _id: id, layerId: layer._id },
          update: { $set: { zIndex: index } },
        },
      })),
    );

    return this.list(layerId);
  }

  /* ------------------------------ validation ------------------------------ */

  /**
   * Runs the structural geometry validation and then bounds-checks against the
   * owning image's real pixel dimensions.
   */
  private validateGeometry(
    type: LayerObjectType,
    raw: Record<string, unknown>,
    image: ImageAssetDocument,
  ): LayerGeometry {
    try {
      return this.geometryValidation.parse(
        type,
        raw,
        image.width && image.height
          ? { width: image.width, height: image.height }
          : undefined,
      );
    } catch (error) {
      if (error instanceof GeometryValidationError) {
        throw ApplicationError.badRequest('INVALID_GEOMETRY', error.message);
      }
      throw error;
    }
  }

  /** An overlay referenced by an IMAGE object must belong to the same image. */
  private async assertOverlayReference(
    type: LayerObjectType,
    geometry: LayerGeometry,
    imageId: Types.ObjectId,
  ): Promise<void> {
    if (type !== 'IMAGE') return;

    const overlayId = (geometry as ImageOverlayGeometry).overlayId;
    if (!/^[0-9a-fA-F]{24}$/.test(overlayId)) {
      throw ApplicationError.badRequest('INVALID_OVERLAY_ID', 'Invalid overlay id');
    }
    const exists = await this.overlayModel
      .exists({ _id: new Types.ObjectId(overlayId), imageAssetId: imageId })
      .exec();
    if (!exists) {
      throw ApplicationError.badRequest(
        'INVALID_OVERLAY_REFERENCE',
        'Overlay does not belong to this image',
      );
    }
  }

  /**
   * Style values are normalized to the known keys for the object type, with
   * numbers clamped to sane ranges, so arbitrary objects cannot be persisted.
   */
  private normalizeStyle(
    type: LayerObjectType,
    raw: Record<string, unknown> | undefined,
  ): LayerObjectStyle {
    const defaults = DEFAULT_STYLE[type];
    if (raw === undefined) {
      return { ...defaults };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw ApplicationError.badRequest('INVALID_STYLE', 'style must be an object');
    }

    const color = (value: unknown, fallback: string): string => {
      if (typeof value !== 'string') return fallback;
      // Accept #rgb/#rrggbb/#rrggbbaa, rgb()/rgba() and a small set of keywords.
      if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return value;
      if (/^(rgb|rgba|hsl|hsla)\([0-9a-zA-Z.,%\s/+-]*\)$/.test(value)) return value;
      if (/^(none|transparent|currentColor)$/.test(value)) return value;
      return fallback;
    };
    const num = (value: unknown, fallback: number, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      return Math.min(max, Math.max(min, value));
    };
    const text = (value: unknown, fallback: string, maxLength: number): string => {
      if (typeof value !== 'string') return fallback;
      const trimmed = value.trim();
      return trimmed.length === 0 ? fallback : trimmed.slice(0, maxLength);
    };

    switch (type) {
      case 'POLYGON':
      case 'RECTANGLE': {
        const base = defaults as { fill: string; fillOpacity: number; stroke: string; strokeWidth: number; strokeOpacity: number };
        return {
          fill: color(raw.fill, base.fill),
          fillOpacity: num(raw.fillOpacity, base.fillOpacity, 0, 1),
          stroke: color(raw.stroke, base.stroke),
          strokeWidth: num(raw.strokeWidth, base.strokeWidth, 0, 100),
          strokeOpacity: num(raw.strokeOpacity, base.strokeOpacity, 0, 1),
        };
      }
      case 'POINT': {
        const base = defaults as { fill: string; stroke: string; strokeWidth: number; radius: number };
        return {
          fill: color(raw.fill, base.fill),
          stroke: color(raw.stroke, base.stroke),
          strokeWidth: num(raw.strokeWidth, base.strokeWidth, 0, 100),
          radius: num(raw.radius, base.radius, 1, 500),
        };
      }
      case 'LABEL': {
        const base = defaults as {
          color: string;
          fontSize: number;
          fontFamily: string;
          backgroundColor: string;
          backgroundOpacity: number;
        };
        return {
          color: color(raw.color, base.color),
          fontSize: num(raw.fontSize, base.fontSize, 4, 512),
          fontFamily: text(raw.fontFamily, base.fontFamily, 120),
          backgroundColor: color(raw.backgroundColor, base.backgroundColor),
          backgroundOpacity: num(raw.backgroundOpacity, base.backgroundOpacity, 0, 1),
        };
      }
      case 'IMAGE': {
        const base = defaults as { opacity: number };
        return { opacity: num(raw.opacity, base.opacity, 0, 1) };
      }
      default:
        throw ApplicationError.badRequest('INVALID_STYLE', 'Unsupported object type');
    }
  }

  private normalizeMetadata(
    type: LayerObjectType,
    raw: Record<string, unknown> | undefined,
  ): LayerObjectMetadata {
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      throw ApplicationError.badRequest('INVALID_METADATA', 'metadata must be an object');
    }
    const source = raw ?? {};

    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 200) : undefined;
    const description =
      typeof source.description === 'string' ? source.description.trim().slice(0, 1000) : undefined;

    if (type === 'LABEL') {
      const rawText = source.text;
      const text = typeof rawText === 'string' ? rawText.slice(0, MAX_TEXT_LENGTH) : '';
      if (text.trim().length === 0) {
        throw ApplicationError.badRequest(
          'INVALID_METADATA',
          'LABEL objects require a non-empty metadata.text (Vietnamese characters are supported)',
        );
      }
      return {
        text,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    }

    return {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  /* -------------------------------- lookups ------------------------------- */

  private async requireLayer(layerId: string): Promise<ImageLayerDocument> {
    if (!/^[0-9a-fA-F]{24}$/.test(layerId)) {
      throw ApplicationError.badRequest('INVALID_LAYER_ID', 'Invalid layer id');
    }
    const layer = await this.layerModel.findById(layerId).exec();
    if (!layer) {
      throw ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer not found');
    }
    return layer;
  }

  private async requireLayerWithImage(
    layerId: string,
  ): Promise<{ layer: ImageLayerDocument; image: ImageAssetDocument }> {
    const layer = await this.requireLayer(layerId);
    const image = await this.imageModel.findById(layer.imageAssetId).exec();
    if (!image) {
      throw ApplicationError.notFound('IMAGE_NOT_FOUND', 'Owning image not found');
    }
    return { layer, image };
  }

  private async requireObject(objectId: string): Promise<LayerObjectDocument> {
    if (!/^[0-9a-fA-F]{24}$/.test(objectId)) {
      throw ApplicationError.badRequest('INVALID_OBJECT_ID', 'Invalid object id');
    }
    const object = await this.objectModel.findById(objectId).exec();
    if (!object) {
      throw ApplicationError.notFound('OBJECT_NOT_FOUND', 'Layer object not found');
    }
    return object;
  }

  toDto(object: LayerObjectDocument): LayerObjectDto {
    return {
      _id: object._id.toString(),
      layerId: object.layerId.toString(),
      type: object.type,
      geometry: object.geometry,
      style: object.style,
      metadata: object.metadata,
      visible: object.visible,
      zIndex: object.zIndex,
      createdAt: (object.createdAt ?? new Date()).toISOString(),
      updatedAt: (object.updatedAt ?? new Date()).toISOString(),
    };
  }
}
