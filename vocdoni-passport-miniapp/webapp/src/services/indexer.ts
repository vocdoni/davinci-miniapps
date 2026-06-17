export async function pingIndexer(indexerUrl: string): Promise<void> {
  const baseUrl = String(indexerUrl || '').replace(/\/+$/, '').trim();
  if (!baseUrl) {
    throw new Error('Indexer URL is unavailable.');
  }

  const response = await fetch(baseUrl, {
    method: 'GET',
    cache: 'no-store',
  });

  if (response.status >= 500) {
    throw new Error(`Indexer ping failed (${response.status})`);
  }
}
