import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  LAYER_OBJECT_TYPES,
  LayerGeometry,
  LayerObjectMetadata,
  LayerObjectStyle,
  LayerObjectType,
} from '@deep-zoom/shared-types';

export type LayerObjectDocument = HydratedDocument<LayerObject>;

/**
 * A drawable object inside a layer.
 *
 * `geometry` is stored as Mixed because its shape depends on `type`; the
 * discriminated union in `@deep-zoom/shared-types` describes the shape and
 * `GeometryValidationService` enforces it before anything is persisted.
 */
@Schema({ collection: 'layer_objects', timestamps: true, versionKey: false })
export class LayerObject {
  @Prop({ type: Types.ObjectId, ref: 'ImageLayer', required: true, index: true })
  layerId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: LAYER_OBJECT_TYPES })
  type!: LayerObjectType;

  @Prop({
    type: Object,
    required: true,
    validate: {
      validator: (value: unknown): boolean =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      message: 'geometry must be a plain object',
    },
  })
  geometry!: LayerGeometry;

  @Prop({
    type: Object,
    required: true,
    default: () => ({}),
    validate: {
      validator: (value: unknown): boolean =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      message: 'style must be a plain object',
    },
  })
  style!: LayerObjectStyle;

  @Prop({
    type: Object,
    required: true,
    default: () => ({}),
    validate: {
      validator: (value: unknown): boolean =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      message: 'metadata must be a plain object',
    },
  })
  metadata!: LayerObjectMetadata;

  @Prop({ type: Boolean, required: true, default: true })
  visible!: boolean;

  @Prop({ type: Number, required: true, default: 0, min: 0, max: 100000 })
  zIndex!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const LayerObjectSchema = SchemaFactory.createForClass(LayerObject);

LayerObjectSchema.index({ layerId: 1, zIndex: 1 });
LayerObjectSchema.index({ layerId: 1, type: 1 });
