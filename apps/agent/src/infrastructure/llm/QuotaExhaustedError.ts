export class QuotaExhaustedError extends Error {
  constructor(
    public readonly provider: string,
    public readonly detail: string,
  ) {
    super(`Quota exhausted for provider "${provider}": ${detail}`);
    this.name = 'QuotaExhaustedError';
  }
}
