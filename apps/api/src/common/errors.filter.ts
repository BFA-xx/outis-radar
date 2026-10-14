import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { redact } from '@outis/engine';

/**
 * Every error leaves the API as { error: { code, message, details? } }.
 * Unexpected errors are logged (redacted) and returned as a generic 500 —
 * stack traces and database messages never reach the client.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      res.status(status).json({
        error: {
          code: (obj.code as string) ?? (status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : 'http_error'),
          message: (obj.message as string) ?? exception.message,
          ...(obj.details ? { details: obj.details } : {}),
        },
      });
      return;
    }
    this.logger.error(redact(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: 'internal', message: 'Internal error' } });
  }
}
