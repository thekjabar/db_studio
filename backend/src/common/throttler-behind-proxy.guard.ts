import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Custom throttler guard that returns a clean, user-facing message instead of
 * the framework default `"ThrottlerException: Too Many Requests"` (which leaks
 * the exception class name into the UI).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(): Promise<string> {
    return 'Too many requests. Please slow down and try again in a moment.';
  }
}
