# Landing page maintenance

The public website is built by `.github/workflows/pages.yml` from two sources. Pull requests build the same output as production. Only a push to `main` or a manual run on `main` deploys it. Configure GitHub Pages to use **GitHub Actions** as its build source.

- `landing/` is the source of truth for the landing page (`index.html` and `assets/landing.css`).
- `docs/` is built by Jekyll for the `/privacy/` and `/terms/` pages and shared static files (`assets/downloads.js`, demo media).

The workflow builds both, refuses to continue if Jekyll produced its own `index.html` or `assets/landing.css`, and publishes the Jekyll output with `landing/dist/` copied on top. Do not add a landing page under `docs/`.

## Landing page source

The landing page uses the [Astryx](https://github.com/meta/astryx) design system: the `Theme` component with the neutral theme, plus `Heading`, `Text`, `Button` and `Link`. React runs only at build time. `landing/src/Page.tsx` is rendered with `renderToStaticMarkup`, and the result ships with no client-side React. Interactive parts are native HTML: links, `<details>` for the FAQ and video description, and `<video>` with captions. Do not add an Astryx component that needs hydration (for example `Collapsible`) without also adding a client bundle.

`landing/` is an isolated pnpm package with its own `pnpm-workspace.yaml` and lockfile, so building it never installs the Electron app's dependencies:

```sh
cd landing
pnpm install --frozen-lockfile --ignore-scripts
pnpm run lint && pnpm run format:check   # oxlint, oxfmt (printWidth 120)
pnpm run typecheck && pnpm run build     # writes landing/dist/
pnpm test                                # page output and downloads.js tests
```

`landing/dist/assets/landing.css` bundles the official Astryx stylesheets in their documented order (`@astryxdesign/core/reset.css`, `@astryxdesign/core/astryx.css`, `@astryxdesign/theme-neutral/theme.css`) followed by `landing/src/site.css`. `site.css` is unlayered and adds only page layout, the brand mark, the illustrative meeting example and the native elements that have no static Astryx component. It reads colors, spacing, radii, shadows and type from Astryx tokens, and targets only the page's own classes so it never restyles Astryx components. Listener's violet appears only in the logo mark and favicon. The neutral theme's Figtree web font is deliberately not loaded, because it would be a third-party request. The token's system font fallback applies, and Korean text uses the platform's Hangul fonts in either case.

All site URLs in the page are relative (`privacy/`, `assets/...`), so it works at the custom domain root and under a project base path. Keep Astryx `core` and `theme-neutral` on the same exact version. Versions newer than pnpm's 24-hour minimum release age cannot be installed; wait instead of adding an exception.

## Download links

The download section has one link per installer: macOS Apple Silicon, macOS Intel and Windows x64. They are native anchors rendered from `DOWNLOAD_PLATFORMS` in `landing/src/site.ts`, not Astryx `Button`s. With children, `Button` sets a fixed `aria-label` and a single-line height, and `ClickableCard` places its content outside the link, so either would keep a stale accessible name once the link is updated. In the static HTML each link opens the GitHub latest release page and says so, which is what visitors get without JavaScript or when anything below fails.

`docs/assets/downloads.js` then requests `https://api.github.com/repos/asleep-ai/listener-ai/releases/latest` once, without credentials and with an 8-second timeout. It accepts the response only when the release is not a draft or prerelease, the tag is a plain `vMAJOR.MINOR.PATCH`, and the release page is in this repository. For each platform it looks for exactly one uploaded, non-empty asset with the expected electron-builder name (`Listener.AI-<version>-arm64.dmg`, `Listener.AI-<version>-x64.dmg`, `Listener.AI-Setup-<version>.exe`) whose download URL is exactly `https://github.com/asleep-ai/listener-ai/releases/download/<tag>/<name>`. Only links that pass are rewritten to the installer and relabelled with the version; any other link keeps its release-page fallback and the note below the links says so. Nothing downloads until the user activates a link, the Mac architecture is never guessed, and nothing is cached or stored.

HTTP errors, unauthenticated API rate limits (60 requests per hour per IP), timeouts and unexpected responses all leave the fallback in place. If installer names change in `package.json` `build` configuration, update `PLATFORMS` in `downloads.js` and its tests in the same change. Platform ids must match `DOWNLOAD_PLATFORMS`; `landing/test/page.test.mjs` checks this against the rendered page. Tests for `downloads.js` itself are in `landing/test/downloads.test.mjs`.

## Demo media

Large demo assets live in the `landing-media-v1` GitHub release rather than Git history. `docs/assets/demos/manifest.json` pins each filename, byte length, and SHA-256 digest. The fetch script accepts only these three assets from the fixed release URL:

- `listener-demo.mp4`
- `listener-demo.jpg`
- `listener-demo.ko.vtt`

Before a build, run `node scripts/fetch-landing-media.mjs`. Existing matching files are reused. A missing asset, HTTP error, oversized response, or digest mismatch fails the build. Run with `--validate-only` to check the manifest without network access.

Create media releases as prereleases with `--latest=false`: they must never replace the application's latest release or update channel. To replace media, prepare and review the actual files first, upload them to the named release, and update the manifest with their exact sizes and SHA-256 values. Do not replace a release asset without updating the manifest. Keep source credits and recording instructions alongside the demo source. The Korean captions and poster must correspond to the shipped video. Avoid recording credentials or personal meeting data.

Check desktop and narrow layouts, keyboard access, caption controls, and reduced-motion behavior before merging. To preview locally, copy the fetched demo media and `docs/assets/downloads.js` into `landing/dist/assets/` and serve `landing/dist/` with any static file server.
