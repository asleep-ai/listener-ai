import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Keep the app's watched directory inodes alive across cases. Replacing a
// directory leaves fs.watch attached to its removed inode on macOS and Linux.
export function clearOwnedFixtureData(dataDir: string, includeConfig = false): void {
  const root = lstatSync(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('The owned fixture root must be a real directory.');
  const preserved = ['recordings', 'metadata', 'transcriptions'];
  // Validate all protected paths before removing any content, so a corrupted
  // fixture cannot redirect cleanup through a symlink into another directory.
  for (const name of preserved) {
    const path = join(dataDir, name);
    try {
      const state = lstatSync(path);
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error(`Protected fixture directory must remain a real directory: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const name of preserved) {
    const path = join(dataDir, name);
    mkdirSync(path, { recursive: true });
    for (const child of readdirSync(path))
      rmSync(join(path, child), { recursive: true, force: true });
  }
  for (const name of readdirSync(dataDir)) {
    if (preserved.includes(name)) continue;
    const path = join(dataDir, name);
    if (
      name === 'chatgpt' ||
      (includeConfig && name === 'config.json') ||
      lstatSync(path).isSymbolicLink() ||
      /\.(wav|webm|m4a)$/.test(name) ||
      name.startsWith('fixture-')
    )
      rmSync(path, { recursive: true, force: true });
  }
}

// Test-only ownership. A failed setup/reset poisons the session instead of
// silently replacing its process and hiding broken test isolation.
export class OwnedSession<T> {
  private resource: T | undefined;
  private failure: unknown;
  private started = false;
  private initializing = false;
  private closed = false;
  private create: () => Promise<T>;
  private dispose: (resource: T) => Promise<void>;

  constructor(create: () => Promise<T>, dispose: (resource: T) => Promise<void>) {
    this.create = create;
    this.dispose = dispose;
  }

  async acquire(initialize: (resource: T) => Promise<void>): Promise<T> {
    if (this.closed || this.failure) throw new Error('The owned test session is unavailable.');
    if (this.initializing) throw new Error('Concurrent initialization is forbidden.');
    if (this.resource) return this.resource;
    if (this.started) throw new Error('Concurrent or replacement launches are forbidden.');
    this.started = true;
    this.initializing = true;
    try {
      this.resource = await this.create();
      await initialize(this.resource);
      return this.resource;
    } catch (error) {
      await this.fail(error);
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  async reset(reset: (resource: T) => Promise<void>): Promise<void> {
    if (!this.resource || this.closed || this.failure)
      throw new Error('Cannot reset an unavailable test session.');
    try {
      await reset(this.resource);
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  async fail(error: unknown): Promise<void> {
    this.failure = error || new Error('Test session failed.');
    await this.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const resource = this.resource;
    this.resource = undefined;
    if (resource) await this.dispose(resource);
  }
}

export function assertCleanReset(state: {
  activeJobs: number;
  pendingInvocations: number;
  configMatches: boolean;
  mocksRestored: boolean;
  dataEmpty: boolean;
}): void {
  if (
    state.activeJobs ||
    state.pendingInvocations ||
    !state.configMatches ||
    !state.mocksRestored ||
    !state.dataEmpty
  )
    throw new Error(`Test isolation failed: ${JSON.stringify(state)}`);
}

export interface WindowState {
  id: number;
  visible: boolean;
  focused: boolean;
  focusable: boolean;
  devTools: boolean;
}

export function assertSingleHiddenWindow(windows: WindowState[], expectedId?: number): number {
  if (
    windows.length !== 1 ||
    windows[0].visible ||
    windows[0].focused ||
    windows[0].focusable ||
    windows[0].devTools ||
    (expectedId !== undefined && windows[0].id !== expectedId)
  ) {
    throw new Error(
      `Expected the same single hidden, unfocused test window: ${JSON.stringify(windows)}`,
    );
  }
  return windows[0].id;
}

export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
