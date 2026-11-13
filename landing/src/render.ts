import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Page } from './Page.js';
import { OG_DESCRIPTION, PAGE_DESCRIPTION, PAGE_TITLE } from './site.js';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%236550ad'/%3E%3Cpath d='M20 15v34h27v-8H28V15z' fill='white'/%3E%3C/svg%3E";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Returns the complete landing document. The document shell is written here
// rather than rendered by React so head elements stay exactly as authored.
// Every URL is relative, so the page works at the site root and under a
// project-page base path alike.
export function renderDocument(): string {
  const body = renderToStaticMarkup(createElement(Page));
  return `<!doctype html>
<html lang="ko" data-theme="light" data-astryx-theme="neutral">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeAttribute(PAGE_DESCRIPTION)}" />
    <meta name="theme-color" content="#f1f1f1" />
    <meta property="og:title" content="${escapeAttribute(PAGE_TITLE)}" />
    <meta property="og:description" content="${escapeAttribute(OG_DESCRIPTION)}" />
    <meta property="og:type" content="website" />
    <link rel="icon" href="${FAVICON}" />
    <link rel="stylesheet" href="assets/landing.css" />
    <script src="assets/downloads.js" defer></script>
    <title>${PAGE_TITLE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
  </head>
  <body>
${body}
  </body>
</html>
`;
}
