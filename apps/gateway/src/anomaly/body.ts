import type { IncomingMessage } from 'node:http';

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export function hasBody(req: IncomingMessage): boolean {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > 0) return true;
  return req.headers['transfer-encoding'] !== undefined;
}

/**
 * Buffer the request body up to `limit` bytes so it can be screened before the proxy replays it
 * (docs/08 risk R4). Rejects with BodyTooLargeError as soon as the limit is crossed.
 */
export function readRawBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
