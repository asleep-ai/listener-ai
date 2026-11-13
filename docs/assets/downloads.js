// Progressive enhancement for the landing page download links.
//
// Without JavaScript, or whenever anything below fails, each platform link
// keeps its static href: the GitHub "latest release" page, labelled as such.
// When the public GitHub API returns a complete stable release, links whose
// installer asset passes every check are pointed at that exact file and
// relabelled with the actual version. Nothing is downloaded until the user
// activates a link, and nothing is stored between visits.
(function () {
  'use strict';

  var OWNER_REPO = 'asleep-ai/listener-ai';
  var API_URL = 'https://api.github.com/repos/' + OWNER_REPO + '/releases/latest';
  var RELEASE_PAGE_PREFIX = 'https://github.com/' + OWNER_REPO + '/releases/tag/';
  var DOWNLOAD_PREFIX = 'https://github.com/' + OWNER_REPO + '/releases/download/';
  var TIMEOUT_MS = 8000;
  // Stable releases only: vMAJOR.MINOR.PATCH, no pre-release or build suffix.
  // This also rejects non-application releases such as `landing-media-v1`.
  var TAG_PATTERN = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

  // Installer file names produced by electron-builder for each platform.
  var PLATFORMS = [
    {
      id: 'mac-arm64',
      assetName: function (version) {
        return 'Listener.AI-' + version + '-arm64.dmg';
      },
      label: 'DMG 내려받기',
    },
    {
      id: 'mac-x64',
      assetName: function (version) {
        return 'Listener.AI-' + version + '-x64.dmg';
      },
      label: 'DMG 내려받기',
    },
    {
      id: 'win-x64',
      assetName: function (version) {
        return 'Listener.AI-Setup-' + version + '.exe';
      },
      label: '설치 프로그램(.exe) 내려받기',
    },
  ];

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // Returns { tag, version, releaseUrl, downloads: { [platformId]: url } } for a
  // validated stable release, or null when the release itself is unusable.
  // A platform whose installer is missing, duplicated or malformed is simply
  // absent from `downloads`, so its link keeps the release-page fallback.
  function resolveRelease(release) {
    if (!isPlainObject(release)) return null;
    if (release.draft !== false || release.prerelease !== false) return null;
    if (typeof release.tag_name !== 'string' || !TAG_PATTERN.test(release.tag_name)) return null;
    var tag = release.tag_name;
    var releaseUrl = RELEASE_PAGE_PREFIX + tag;
    if (release.html_url !== releaseUrl) return null;
    if (!Array.isArray(release.assets)) return null;

    var version = tag.slice(1);
    var downloads = {};
    PLATFORMS.forEach(function (platform) {
      var name = platform.assetName(version);
      var matches = release.assets.filter(function (asset) {
        return isPlainObject(asset) && asset.name === name;
      });
      if (matches.length !== 1) return;
      var asset = matches[0];
      var expectedUrl = DOWNLOAD_PREFIX + tag + '/' + name;
      if (
        asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.browser_download_url === expectedUrl
      ) {
        downloads[platform.id] = expectedUrl;
      }
    });
    return { tag: tag, version: version, releaseUrl: releaseUrl, downloads: downloads };
  }

  // Fetches the latest stable release with a bounded timeout. Resolves to the
  // resolveRelease() result, or null on any network, HTTP or parsing failure
  // (including rate limiting).
  function fetchLatestRelease(fetchImpl, options) {
    var timeoutMs = (options && options.timeoutMs) || TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () {
        if (controller) controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    var request = Promise.resolve()
      .then(function () {
        return fetchImpl(API_URL, {
          headers: { Accept: 'application/vnd.github+json' },
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller ? controller.signal : undefined,
        });
      })
      .then(function (response) {
        if (!response || !response.ok) return null;
        return response.json().then(resolveRelease);
      })
      .catch(function () {
        return null;
      });
    return Promise.race([request, timeout]).then(function (result) {
      clearTimeout(timer);
      return result;
    });
  }

  function setText(root, selector, text) {
    var node = root.querySelector(selector);
    if (node) node.textContent = text;
  }

  // Applies a resolveRelease() result to the download section. Links without a
  // validated installer, and the whole section when `resolved` is null, are
  // left exactly as the static HTML describes them.
  function applyRelease(doc, resolved) {
    if (!resolved) return 0;
    var applied = 0;
    PLATFORMS.forEach(function (platform) {
      var url = resolved.downloads[platform.id];
      var link = doc.querySelector('[data-download-platform="' + platform.id + '"]');
      if (!url || !link) return;
      link.setAttribute('href', url);
      setText(link, '[data-download-detail]', resolved.tag + ' · ' + platform.label);
      setText(link, '[data-download-icon]', '↓');
      applied += 1;
    });

    var status = doc.querySelector('[data-download-status]');
    if (status && applied > 0) {
      var message =
        applied === PLATFORMS.length
          ? '최신 버전 ' + resolved.tag + ' 설치 파일을 GitHub에서 바로 내려받습니다. '
          : '최신 버전은 ' +
            resolved.tag +
            '입니다. 일부 설치 파일은 아직 준비되지 않아 릴리스 페이지가 열립니다. ';
      status.textContent = message;
      var notes = doc.createElement('a');
      notes.setAttribute('href', resolved.releaseUrl);
      notes.textContent = resolved.tag + ' 릴리스 노트';
      status.appendChild(notes);
      status.appendChild(doc.createTextNode('에서 변경 사항을 확인하세요.'));
    }
    return applied;
  }

  function enhance(doc, fetchImpl, options) {
    if (!doc.querySelector('[data-download-platform]')) return Promise.resolve(0);
    return fetchLatestRelease(fetchImpl, options).then(function (resolved) {
      return applyRelease(doc, resolved);
    });
  }

  var api = {
    API_URL: API_URL,
    TIMEOUT_MS: TIMEOUT_MS,
    PLATFORMS: PLATFORMS,
    resolveRelease: resolveRelease,
    fetchLatestRelease: fetchLatestRelease,
    applyRelease: applyRelease,
    enhance: enhance,
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (typeof document !== 'undefined' && typeof fetch === 'function') {
    enhance(document, fetch.bind(window));
  }
})();
