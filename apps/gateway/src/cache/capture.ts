import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

export interface CapturedResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  /** null when the body exceeded maxBytes (capture abandoned, response still streamed). */
  body: Buffer | null;
}

/**
 * Tee what the proxy streams to the client so the cache can store it afterwards, without
 * buffering the response or delaying it. Bodies above maxBytes are streamed but not kept.
 */
export function captureResponse(
  res: ServerResponse,
  maxBytes: number,
  onDone: (captured: CapturedResponse) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let done = false;

  const remember = (chunk: unknown, encoding: unknown): void => {
    if (truncated || chunk === null || chunk === undefined) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(
            chunk,
            typeof encoding === 'string'
              ? (encoding as BufferEncoding)
              : 'utf8',
          )
        : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) {
      truncated = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  };

  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const originalEnd = res.end.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    remember(chunk, rest[0]);
    return originalWrite(chunk, ...rest);
  }) as typeof res.write;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== 'function') remember(chunk, rest[0]);
    const result = originalEnd(chunk, ...rest);
    if (!done) {
      done = true;
      onDone({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: truncated ? null : Buffer.concat(chunks),
      });
    }
    return result;
  }) as typeof res.end;
}
