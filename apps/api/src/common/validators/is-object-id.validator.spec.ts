import { validate } from 'class-validator';
import { IsObjectId, IsObjectIdEach, isObjectIdString, OBJECT_ID_MESSAGE } from './is-object-id.validator';

class Sample {
  @IsObjectId()
  id!: string;

  @IsObjectIdEach()
  ids!: string[];
}

const VALID_ID = '64b0000000000000000000a1';

describe('isObjectIdString', () => {
  it('accepts a 24-character hexadecimal id', () => {
    expect(isObjectIdString(VALID_ID)).toBe(true);
  });

  it('accepts uppercase hexadecimal', () => {
    expect(isObjectIdString(VALID_ID.toUpperCase())).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['not-an-id', 'arbitrary text'],
    ['64b0000000000000000000a', 'too short'],
    ['64b0000000000000000000a11', 'too long'],
    ['64b0000000000000000000zz', 'non hexadecimal characters'],
    ['zzzzzzzzzzzzzzzzzzzzzzzz', 'entirely non hexadecimal'],
  ])('rejects %p (%s)', (value) => {
    expect(isObjectIdString(value)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isObjectIdString(123)).toBe(false);
    expect(isObjectIdString(null)).toBe(false);
    expect(isObjectIdString(undefined)).toBe(false);
    expect(isObjectIdString({})).toBe(false);
  });
});

describe('IsObjectId', () => {
  it('accepts a valid id', async () => {
    const sample = new Sample();
    sample.id = VALID_ID;
    sample.ids = [VALID_ID];

    const errors = await validate(sample);

    expect(errors).toHaveLength(0);
  });

  it('reports an invalid id with a readable message', async () => {
    const sample = new Sample();
    sample.id = 'nope';
    sample.ids = [VALID_ID];

    const errors = await validate(sample);

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      `id ${OBJECT_ID_MESSAGE}`,
    );
  });
});

describe('IsObjectIdEach', () => {
  it('rejects an array containing an invalid id', async () => {
    const sample = new Sample();
    sample.id = VALID_ID;
    sample.ids = [VALID_ID, 'nope'];

    const errors = await validate(sample);

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      `each value of ids ${OBJECT_ID_MESSAGE}`,
    );
  });

  it('rejects a non-array value', async () => {
    const sample = new Sample();
    sample.id = VALID_ID;
    sample.ids = 'not-an-array' as unknown as string[];

    const errors = await validate(sample);

    expect(errors).toHaveLength(1);
  });
});
