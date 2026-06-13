import type { IEmbeddingAdapter } from '@emma/core/ports';

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export class VoyageEmbeddingAdapter implements IEmbeddingAdapter {
  readonly dimensions = 1024;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'voyage-3-lite',
  ) {}

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    const first = results[0];
    if (!first) throw new Error('No embedding returned');
    return first;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage AI error ${response.status}: ${error}`);
    }

    const data = (await response.json()) as VoyageResponse;
    return data.data.map((d) => d.embedding);
  }
}
