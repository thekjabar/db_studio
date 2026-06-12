export const QUEUE_EXEC = 'schedules-exec';
export const QUEUE_EMAIL = 'schedules-email';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export interface ExecJobData {
  scheduleId: string;
}

export interface EmailJobData {
  scheduleId: string;
  runId: string;
  to: string[];
  subject: string;
  body: string;
  /** Optional rich HTML body — includes an inline preview table of results. */
  html?: string;
  /** CSV payload (utf-8) — sent as an attachment named `<schedule>.csv`. */
  csv?: string;
  filename?: string;
}
