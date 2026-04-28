const REPO = 'asleep-ai/listener-ai';

const COMMON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'listener-ai',
  'X-GitHub-Api-Version': '2022-11-28',
};

export interface ReleaseNotes {
  version: string;
  tag: string;
  body: string;
  url: string;
  publishedAt: string | null;
}

export interface ReleaseSummary {
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
}

export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes | null> {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  console.log(`Release notes fetch: GET ${apiUrl}`);

  try {
    const res = await fetch(apiUrl, { headers: COMMON_HEADERS });
    if (!res.ok) {
      console.warn(`Release notes fetch failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as {
      body?: string;
      html_url?: string;
      published_at?: string | null;
      tag_name?: string;
    };
    console.log(`Release notes fetch: ok, body=${(data.body || '').length} chars`);
    return {
      version,
      tag,
      body: data.body || '',
      url: data.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
      publishedAt: data.published_at ?? null,
    };
  } catch (error) {
    console.error('Failed to fetch release notes:', error);
    return null;
  }
}

export async function fetchAllReleases(limit = 30): Promise<ReleaseSummary[]> {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases?per_page=${Math.min(limit, 100)}`;
  console.log(`Release list fetch: GET ${apiUrl}`);
  try {
    const res = await fetch(apiUrl, { headers: COMMON_HEADERS });
    if (!res.ok) {
      console.warn(`Release list fetch failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as Array<{
      tag_name?: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string | null;
      prerelease?: boolean;
      draft?: boolean;
    }>;
    const results = data
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name || '',
        name: r.name || r.tag_name || '',
        body: r.body || '',
        url: r.html_url || `https://github.com/${REPO}/releases`,
        publishedAt: r.published_at ?? null,
        prerelease: Boolean(r.prerelease),
        draft: Boolean(r.draft),
      }));
    console.log(`Release list fetch: ok, ${results.length} releases`);
    return results;
  } catch (error) {
    console.error('Failed to fetch release list:', error);
    return [];
  }
}
