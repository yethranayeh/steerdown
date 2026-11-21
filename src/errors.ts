/** An expected failure: the CLI prints its message without a stack trace and exits with its code. */
export class ReportedError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
