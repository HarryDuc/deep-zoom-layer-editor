import { registerDecorator, ValidationOptions } from 'class-validator';
import { Types } from 'mongoose';

export const OBJECT_ID_MESSAGE = 'must be a valid 24-character hexadecimal ObjectId';

export function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value) && Types.ObjectId.isValid(value);
}

/**
 * Validates that a value is a well-formed MongoDB ObjectId string. Using a
 * strict regex (instead of `Types.ObjectId.isValid` alone) prevents 12-char
 * arbitrary strings from being silently accepted.
 */
export function IsObjectId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isObjectId',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isObjectIdString(value);
        },
        defaultMessage(): string {
          return `$property ${OBJECT_ID_MESSAGE}`;
        },
      },
    });
  };
}

/** Array variant of {@link IsObjectId}. */
export function IsObjectIdEach(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isObjectIdEach',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return Array.isArray(value) && value.every((item) => isObjectIdString(item));
        },
        defaultMessage(): string {
          return `each value of $property ${OBJECT_ID_MESSAGE}`;
        },
      },
    });
  };
}
