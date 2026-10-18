export type JobContext = {
  jobId: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  attempt: number;
};

/** Thrown by a handler to say how a failure should be treated (retry with backoff vs dead-letter). */
export class JobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, code: string, opts: { retryable?: boolean; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.retryable = opts.retryable ?? true;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;
