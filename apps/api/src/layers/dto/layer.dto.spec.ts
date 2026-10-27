import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLayerDto, UpdateLayerDto } from './layer.dto';

/** Validates a payload and returns the list of failed constraint names. */
async function constraintNames(
  cls: typeof CreateLayerDto | typeof UpdateLayerDto,
  payload: unknown,
): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object, { whitelist: true });

  return errors.flatMap((error) =>
    Object.keys(error.constraints ?? {}).map((name) => `${error.property}.${name}`),
  );
}

describe('layer DTOs', () => {
  describe('CreateLayerDto', () => {
    it('accepts a valid layer', async () => {
      await expect(constraintNames(CreateLayerDto, { name: 'Lớp địa hình' })).resolves.toEqual(
        [],
      );
    });

    it('accepts the optional flags', async () => {
      await expect(
        constraintNames(CreateLayerDto, {
          name: 'Lớp',
          visible: false,
          locked: true,
          zIndex: 3,
        }),
      ).resolves.toEqual([]);
    });

    it('rejects a missing name', async () => {
      await expect(constraintNames(CreateLayerDto, {})).resolves.toContain('name.isString');
    });

    it('rejects an empty name', async () => {
      await expect(constraintNames(CreateLayerDto, { name: '' })).resolves.toContain(
        'name.minLength',
      );
    });

    it('rejects a name longer than 120 characters', async () => {
      const names = await constraintNames(CreateLayerDto, { name: 'a'.repeat(121) });
      expect(names).toContain('name.maxLength');
    });

    it('accepts a name of exactly 120 characters', async () => {
      await expect(
        constraintNames(CreateLayerDto, { name: 'a'.repeat(120) }),
      ).resolves.toEqual([]);
    });

    it('rejects a non-boolean visible flag', async () => {
      await expect(
        constraintNames(CreateLayerDto, { name: 'Lớp', visible: 'yes' }),
      ).resolves.toContain('visible.isBoolean');
    });

    it('rejects a negative zIndex', async () => {
      await expect(
        constraintNames(CreateLayerDto, { name: 'Lớp', zIndex: -1 }),
      ).resolves.toContain('zIndex.min');
    });

    it('rejects a zIndex above the maximum', async () => {
      await expect(
        constraintNames(CreateLayerDto, { name: 'Lớp', zIndex: 100_001 }),
      ).resolves.toContain('zIndex.max');
    });

    it('coerces a numeric string zIndex', async () => {
      const instance = plainToInstance(CreateLayerDto, { name: 'Lớp', zIndex: '7' });
      await expect(validate(instance)).resolves.toEqual([]);
      expect(instance.zIndex).toBe(7);
    });
  });

  describe('UpdateLayerDto', () => {
    it('accepts an empty patch', async () => {
      await expect(constraintNames(UpdateLayerDto, {})).resolves.toEqual([]);
    });

    it('accepts a name-only patch', async () => {
      await expect(constraintNames(UpdateLayerDto, { name: 'Đổi tên' })).resolves.toEqual([]);
    });

    it('rejects an empty name', async () => {
      await expect(constraintNames(UpdateLayerDto, { name: '' })).resolves.toContain(
        'name.minLength',
      );
    });

    it('rejects a non-boolean locked flag', async () => {
      await expect(constraintNames(UpdateLayerDto, { locked: 1 })).resolves.toContain(
        'locked.isBoolean',
      );
    });

    it('rejects a fractional zIndex', async () => {
      await expect(constraintNames(UpdateLayerDto, { zIndex: 1.5 })).resolves.toContain(
        'zIndex.isInt',
      );
    });
  });
});
