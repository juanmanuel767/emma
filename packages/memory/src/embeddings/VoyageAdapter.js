export class VoyageEmbeddingAdapter {
    apiKey;
    model;
    dimensions = 1024;
    constructor(apiKey, model = 'voyage-3-lite') {
        this.apiKey = apiKey;
        this.model = model;
    }
    async embed(text) {
        const results = await this.embedBatch([text]);
        const first = results[0];
        if (!first)
            throw new Error('No embedding returned');
        return first;
    }
    async embedBatch(texts) {
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
        const data = (await response.json());
        return data.data.map((d) => d.embedding);
    }
}
//# sourceMappingURL=VoyageAdapter.js.map