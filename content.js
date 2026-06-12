const PAGE_PATH_RE = /^\/[^/]+\/[^/]+\/blob\/.+\/Project\/Sources\/dependencies\.json$/;
const DEPENDENCIES_START_RE = /^\s*"dependencies":\s*\{\s*$/;
const DEPENDENCY_START_RE = /^\s*"([^"]+)":\s*\{\s*$/;
const FIELD_RE = /^\s*"([^"]+)":\s*"([^"]+)"\s*,?\s*$/;
const OBJECT_END_RE = /^\s*}\s*,?\s*$/;
const CODE_CELL_SELECTORS = ['[data-testid="code-cell"]', '.react-file-line', '[id^="LC"]'];
const LOG_PREFIX = '[4D Dependency Linkifier]';
const OVERLAY_SELECTOR = '#read-only-cursor-text-area, [data-testid="read-only-cursor-text-area"]';
const CODE_CONTAINER_STOP_SELECTOR = '[data-testid="code-lines-container"], .react-code-line-container';

const state = {
  scheduled: false,
  enhancing: false,
  cacheKey: "",
  dependencies: null,
  observer: null,
};

function log(message, details) {
  if (typeof details === 'undefined') {
    console.log(`${LOG_PREFIX} ${message}`);
    return;
  }

  console.log(`${LOG_PREFIX} ${message}`, details);
}

function isTargetPage() {
  return PAGE_PATH_RE.test(location.pathname);
}

function getRawUrl() {
  const rawButton = document.querySelector('a[data-testid="raw-button"]');

  if (rawButton instanceof HTMLAnchorElement && rawButton.href) {
    return rawButton.href;
  }

  if (!location.href.includes('/blob/')) {
    return null;
  }

  return location.href.replace('/blob/', '/raw/');
}

async function getDependencies() {
  const cacheKey = location.href;

  if (state.cacheKey === cacheKey && state.dependencies) {
    log('Using cached dependencies', {
      cacheKey,
      count: state.dependencies.size,
    });
    return state.dependencies;
  }

  const rawUrl = getRawUrl();

  if (!rawUrl) {
    log('No raw URL found for page', { href: location.href });
    return null;
  }

  log('Fetching raw dependencies.json', { rawUrl });

  const response = await fetch(rawUrl, { credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error(`Unable to fetch raw dependencies.json (${response.status})`);
  }

  const json = await response.json();
  const dependencies = new Map();
  const source = json?.dependencies;

  if (source && typeof source === 'object') {
    for (const [name, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object' || typeof value.github !== 'string' || !value.github) {
        continue;
      }

      dependencies.set(name, {
        github: value.github,
        tag: typeof value.tag === 'string' && value.tag ? value.tag : null,
      });
    }
  }

  state.cacheKey = cacheKey;
  state.dependencies = dependencies;
  log('Parsed dependencies from raw JSON', {
    count: dependencies.size,
    names: Array.from(dependencies.keys()),
  });
  return dependencies;
}

function buildReleaseUrl(repository, tag) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}

function getSearchRoots() {
  const roots = [document];
  const elements = Array.from(document.querySelectorAll('*'));

  for (const element of elements) {
    if (element.shadowRoot) {
      roots.push(element.shadowRoot);
    }
  }

  return roots;
}

function getCodeCells() {
  const roots = getSearchRoots();
  const seen = new Set();
  const codeCells = [];
  const selectorCounts = {};

  for (const selector of CODE_CELL_SELECTORS) {
    selectorCounts[selector] = 0;

    for (const root of roots) {
      const matches = Array.from(root.querySelectorAll(selector));
      selectorCounts[selector] += matches.length;

      for (const match of matches) {
        if (!(match instanceof HTMLElement) || seen.has(match)) {
          continue;
        }

        seen.add(match);
        codeCells.push(match);
      }
    }
  }

  codeCells.sort((left, right) => {
    const leftLine = Number.parseInt(left.getAttribute('data-line-number') || left.id.replace(/^LC/, ''), 10);
    const rightLine = Number.parseInt(right.getAttribute('data-line-number') || right.id.replace(/^LC/, ''), 10);

    return leftLine - rightLine;
  });

  return {
    codeCells,
    selectorCounts,
    rootCount: roots.length,
  };
}

function createLink(value, href) {
  const link = document.createElement('a');

  link.href = href;
  link.textContent = value;
  link.dataset.chrome4dDepLink = 'true';
  link.style.color = 'var(--fgColor-accent, #0969da)';
  link.style.textDecoration = 'underline';
  link.style.position = 'relative';
  link.style.zIndex = '3';
  link.style.pointerEvents = 'auto';
  link.style.cursor = 'pointer';

  return link;
}

function makeCodeInteractive(lineElement) {
  lineElement.removeAttribute('inert');
  lineElement.style.pointerEvents = 'auto';
  lineElement.style.zIndex = '2';

  let currentElement = lineElement.parentElement;

  while (currentElement instanceof HTMLElement) {
    currentElement.removeAttribute('inert');
    currentElement.style.pointerEvents = 'auto';

    if (currentElement.matches(CODE_CONTAINER_STOP_SELECTOR)) {
      break;
    }

    currentElement = currentElement.parentElement;
  }

  const overlay = document.querySelector(OVERLAY_SELECTOR);

  if (overlay instanceof HTMLElement) {
    overlay.style.pointerEvents = 'none';
  }
}

function replaceValueWithLink(lineElement, value, href) {
  if (lineElement.querySelector(`a[data-chrome4d-dep-link="true"][href="${href}"]`)) {
    makeCodeInteractive(lineElement);
    return false;
  }

  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement) {
        return NodeFilter.FILTER_REJECT;
      }

      if (node.parentElement.closest('a[data-chrome4d-dep-link="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }

      return typeof node.textContent === 'string' && node.textContent.includes(value)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const textNode = walker.nextNode();

  if (!textNode || !textNode.parentNode || typeof textNode.textContent !== 'string') {
    log('String text node not found for line', {
      line: lineElement.textContent || '',
      value,
      href,
    });
    return false;
  }

  const valueOffset = textNode.textContent.indexOf(value);

  if (valueOffset < 0) {
    log('Value offset not found inside text node', {
      line: lineElement.textContent || '',
      value,
      href,
    });
    return false;
  }

  const fragment = document.createDocumentFragment();
  const before = textNode.textContent.slice(0, valueOffset);
  const after = textNode.textContent.slice(valueOffset + value.length);

  if (before) {
    fragment.appendChild(document.createTextNode(before));
  }

  const link = createLink(value, href);
  fragment.appendChild(link);

  if (after) {
    fragment.appendChild(document.createTextNode(after));
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  makeCodeInteractive(lineElement);
  log('Inserted link', {
    value,
    href,
    line: lineElement.textContent || '',
  });
  return true;
}

function linkifyDependencies(codeCells, dependencies) {
  let insideDependencies = false;
  let currentDependency = null;
  let insertedLinks = 0;

  for (const lineElement of codeCells) {
    const lineText = lineElement.textContent || '';

    if (!insideDependencies) {
      if (DEPENDENCIES_START_RE.test(lineText)) {
        insideDependencies = true;
      }

      continue;
    }

    if (!currentDependency) {
      if (OBJECT_END_RE.test(lineText)) {
        insideDependencies = false;
        continue;
      }

      const dependencyMatch = lineText.match(DEPENDENCY_START_RE);

      if (dependencyMatch) {
        currentDependency = dependencyMatch[1];
      }

      continue;
    }

    const dependencyInfo = dependencies.get(currentDependency);
    const fieldMatch = lineText.match(FIELD_RE);

    if (dependencyInfo && fieldMatch) {
      const [, fieldName, fieldValue] = fieldMatch;

      if (fieldName === 'github' && fieldValue === dependencyInfo.github) {
        if (replaceValueWithLink(lineElement, fieldValue, `https://github.com/${dependencyInfo.github}`)) {
          insertedLinks += 1;
        }
      }

      if (fieldName === 'tag' && dependencyInfo.tag && fieldValue === dependencyInfo.tag) {
        if (replaceValueWithLink(lineElement, fieldValue, buildReleaseUrl(dependencyInfo.github, dependencyInfo.tag))) {
          insertedLinks += 1;
        }
      }
    }

    if (OBJECT_END_RE.test(lineText)) {
      currentDependency = null;
    }
  }

  return insertedLinks;
}

async function enhancePage() {
  if (state.enhancing) {
    log('Enhancement already in progress, skipping');
    return;
  }

  if (!isTargetPage()) {
    if (state.cacheKey || state.dependencies) {
      log('Leaving target page, clearing cache', { path: location.pathname });
    }

    state.cacheKey = '';
    state.dependencies = null;
    return;
  }

  const { codeCells, selectorCounts, rootCount } = getCodeCells();

  if (codeCells.length === 0) {
    log('No code cells found yet', {
      path: location.pathname,
      selectorCounts,
      rootCount,
    });
    return;
  }

  state.enhancing = true;
  log('Enhancing page', {
    href: location.href,
    codeCellCount: codeCells.length,
    selectorCounts,
    rootCount,
  });

  const overlay = document.querySelector(OVERLAY_SELECTOR);

  if (overlay instanceof HTMLElement) {
    overlay.style.pointerEvents = 'none';
    log('Disabled GitHub textarea overlay pointer events');
  }

  try {
    const dependencies = await getDependencies();

    if (!dependencies || dependencies.size === 0) {
      log('No linkable dependencies found', { href: location.href });
      return;
    }

    const insertedLinks = linkifyDependencies(codeCells, dependencies);
    log('Enhancement complete', {
      href: location.href,
      dependencyCount: dependencies.size,
      insertedLinks,
    });
  } catch (error) {
    console.warn('4D Dependency Linkifier:', error);
  } finally {
    state.enhancing = false;
  }
}

function scheduleEnhance(reason = 'unspecified') {
  if (state.scheduled) {
    return;
  }

  state.scheduled = true;
  log('Scheduling enhancement', { reason, href: location.href });

  setTimeout(() => {
    state.scheduled = false;
    void enhancePage();
  }, 50);
}

function installObserver() {
  if (state.observer) {
    return;
  }

  state.observer = new MutationObserver(() => {
    scheduleEnhance('mutation');
  });

  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

document.addEventListener('turbo:load', () => {
  scheduleEnhance('turbo:load');
});
document.addEventListener('turbo:render', () => {
  scheduleEnhance('turbo:render');
});
window.addEventListener('popstate', () => {
  scheduleEnhance('popstate');
});

installObserver();
log('Content script loaded', { href: location.href, path: location.pathname });
scheduleEnhance('initial-load');