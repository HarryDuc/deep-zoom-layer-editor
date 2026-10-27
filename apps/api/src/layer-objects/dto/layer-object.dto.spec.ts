import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LAYER_OBJECT_TYPES } from '@deep-zoom/shared-types';
import {
  CreateLayerObjectDto,
  LayerObjectBatchDto,
  ReorderObjectsDto,
  UpdateLayerObjectDto,
} from './layer-object.dto';

const OBJECT_ID = '507f1f77bcf86cd799439011';

/** Validates a payload and returns the list of failed constraint names. */
async function constraintNames(
  cls: typeof CreateLayerObjectDto | typeof UpdateLayerObjectDto,
  payload: unknown,
): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object, { whitelist: true });

  return errors.flatMap((error) =>
    Object.keys(error.constraints ?? {}).map((name) => `${error.property}.${name}`),
  );
}

describe('layer object DTOs', () => {
  describe('CreateLayerObjectDto', () => {
    it('accepts a minimal valid object', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, {
          type: 'POINT',
          geometry: { x: 1, y: 2 },
        }),
      ).resolves.toEqual([]);
    });

    it('accepts every documented object type', async () => {
      for (const type of LAYER_OBJECT_TYPES) {
        await expect(
          constraintNames(CreateLayerObjectDto, { type, geometry: {} }),
        ).resolves.toEqual([]);
      }
    });

    it('rejects an unknown object type', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, { type: 'TRIANGLE', geometry: {} }),
      ).resolves.toContain('type.isIn');
    });

    it('rejects a missing geometry', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, { type: 'POINT' }),
      ).resolves.toContain('geometry.isObject');
    });

    it('rejects a non-object geometry', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, { type: 'POINT', geometry: 'x' }),
      ).resolves.toContain('geometry.isObject');
    });

    it('rejects an array geometry', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, { type: 'POLYGON', geometry: [] }),
      ).resolves.toContain('geometry.isObject');
    });

    it('accepts optional style, metadata and visibility', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, {
          type: 'RECTANGLE',
          geometry: { x: 0, y: 0, width: 1, height: 1 },
          style: { fill: '#ff0000' },
          metadata: { text: 'Nhãn' },
          visible: false,
          zIndex: 2,
        }),
      ).resolves.toEqual([]);
    });

    it('rejects a non-boolean visible flag', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, {
          type: 'POINT',
          geometry: {},
          visible: 'no',
        }),
      ).resolves.toContain('visible.isBoolean');
    });

    it('rejects a negative zIndex', async () => {
      await expect(
        constraintNames(CreateLayerObjectDto, {
          type: 'POINT',
          geometry: {},
          zIndex: -5,
        }),
      ).resolves.toContain('zIndex.min');
    });
  });

  describe('UpdateLayerObjectDto', () => {
    it('accepts an empty patch', async () => {
      await expect(constraintNames(UpdateLayerObjectDto, {})).resolves.toEqual([]);
    });

    it('accepts a style-only patch', async () => {
      await expect(
        constraintNames(UpdateLayerObjectDto, { style: { fill: '#00ff00' } }),
      ).resolves.toEqual([]);
    });

    it('rejects a non-object style', async () => {
      await expect(constraintNames(UpdateLayerObjectDto, { style: 'red' })).resolves.toContain(
        'style.isObject',
      );
    });

    it('rejects a zIndex above the maximum', async () => {
      await expect(
        constraintNames(UpdateLayerObjectDto, { zIndex: 100_001 }),
      ).resolves.toContain('zIndex.max');
    });
  });

  describe('ReorderObjectsDto', () => {
    it('accepts a list of object ids', async () => {
      const instance = plainToInstance(ReorderObjectsDto, {
        orderedObjectIds: [OBJECT_ID],
      });

      await expect(validate(instance)).resolves.toEqual([]);
    });

    it('rejects a missing list', async () => {
      const instance = plainToInstance(ReorderObjectsDto, {});

      const errors = await validate(instance);
      expect(errors.map((error) => error.property)).toContain('orderedObjectIds');
    });

    it('rejects a non-string entry', async () => {
      const instance = plainToInstance(ReorderObjectsDto, {
        orderedObjectIds: [123],
      });

      const errors = await validate(instance);
      expect(errors.map((error) => error.property)).toContain('orderedObjectIds');
    });

    it('rejects a malformed object id', async () => {
      const instance = plainToInstance(ReorderObjectsDto, {
        orderedObjectIds: ['not-an-object-id'],
      });

      const errors = await validate(instance);
      expect(errors.map((error) => error.property)).toContain('orderedObjectIds');
    });
  });

  describe('LayerObjectBatchDto', () => {
    it('accepts a batch of valid objects', async () => {
      const instance = plainToInstance(LayerObjectBatchDto, {
        objects: [
          { type: 'POINT', geometry: { x: 1, y: 1 } },
          { type: 'RECTANGLE', geometry: { x: 0, y: 0, width: 2, height: 2 } },
        ],
      });

      await expect(validate(instance)).resolves.toEqual([]);
    });

    it('rejects a batch containing an invalid object', async () => {
      const instance = plainToInstance(LayerObjectBatchDto, {
        objects: [{ type: 'NOPE', geometry: {} }],
      });

      const errors = await validate(instance);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing objects list', async () => {
      const instance = plainToInstance(LayerObjectBatchDto, {});

      const errors = await validate(instance);
      expect(errors.map((error) => error.property)).toContain('objects');
    });
  });
});
