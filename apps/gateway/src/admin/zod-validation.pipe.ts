import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { Problems } from '../common/problem/problem.js';

/**
 * Validates a body or query object against a zod schema and turns failures into the same
 * RFC 7807 shape as the rest of the gateway, listing every offending field at once.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const detail = result.error.issues
      .map(
        (issue) =>
          `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`,
      )
      .join('; ');
    throw Problems.badRequest(detail);
  }
}

export const validate = <T>(schema: ZodType<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
