# Landing page maintenance

The public website is built from `docs/` by `.github/workflows/pages.yml`. Pull requests build the same Jekyll output as production, including the existing `/privacy/` and `/terms/` pages. Only a push to `main` or a manual run on `main` deploys it. Configure GitHub Pages to use **GitHub Actions** as its build source.

## Demo media

Large demo assets live in the `landing-media-v1` GitHub release rather than Git history. `docs/assets/demos/manifest.json` pins each filename, byte length, and SHA-256 digest. The fetch script accepts only these three assets from the fixed release URL:

- `listener-demo.mp4`
- `listener-demo.jpg`
- `listener-demo.ko.vtt`

Before a build, run `node scripts/fetch-landing-media.mjs`. Existing matching files are reused. A missing asset, HTTP error, oversized response, or digest mismatch fails the build. Run with `--validate-only` to check the manifest without network access.

Create media releases as prereleases with `--latest=false`: they must never replace the application's latest release or update channel. To replace media, prepare and review the actual files first, upload them to the named release, and update the manifest with their exact sizes and SHA-256 values. Do not replace a release asset without updating the manifest. Keep source credits and recording instructions alongside the demo source. The Korean captions and poster must correspond to the shipped video. Avoid recording credentials or personal meeting data.

Keep the landing page's `layout: null` frontmatter: Jekyll renders legal Markdown pages with the existing theme while leaving the custom landing layout intact. Check desktop and narrow layouts, keyboard access, caption controls, and reduced-motion behavior before merging.
