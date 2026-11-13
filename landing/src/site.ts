// Fixed site facts shared by the page and its tests.

export const REPOSITORY_URL = 'https://github.com/asleep-ai/listener-ai';

// Static fallback for every download link. `downloads.js` replaces it with a
// direct installer URL only after validating the latest stable release.
export const RELEASE_PAGE_URL = `${REPOSITORY_URL}/releases/latest`;

// Ids must match `PLATFORMS` in docs/assets/downloads.js.
export const DOWNLOAD_PLATFORMS = [
  { id: 'mac-arm64', name: 'macOS · Apple Silicon', fallbackDetail: 'M 시리즈 칩 · 릴리스 페이지 열기' },
  { id: 'mac-x64', name: 'macOS · Intel', fallbackDetail: 'Intel 프로세서 · 릴리스 페이지 열기' },
  { id: 'win-x64', name: 'Windows', fallbackDetail: 'x64 설치 프로그램 · 릴리스 페이지 열기' },
] as const;

export const PAGE_TITLE = 'Listener.AI — 대화가 끝나면, 다음 할 일이 보이도록';
export const PAGE_DESCRIPTION =
  '회의를 녹음하고, 대화록과 요약, 담당자별 할 일을 정리하세요. 내 컴퓨터에 보관하는 AI 회의 노트, Listener.AI.';
export const OG_DESCRIPTION = '녹음부터 대화록, 회의 요약, 다시 찾기까지. 내 컴퓨터에 보관하는 AI 회의 노트.';
