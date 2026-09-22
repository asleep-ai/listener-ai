// Compile-time guard for the derived `ElectronAPI`; emits no runtime code and
// is imported by nothing. `ipcRenderer.invoke` resolves to `any`, so a preload
// member that loses its explicit return annotation would silently widen to
// `Promise<any>` and take every renderer callsite's type with it. `AssertNever`
// then fails this file and names the offending member. Lives here rather than
// in `electronAPI.d.ts` because `skipLibCheck` skips declaration files. Only
// return types are inspected, so the deliberately-`any` callback parameters
// (onFFmpegDownloadProgress, onUpdateStatus) are unaffected.
import type { ElectronAPI } from './electronAPI';

type AnyReturningMember = {
  [K in keyof ElectronAPI]: ElectronAPI[K] extends (...args: never[]) => infer R
    ? 0 extends 1 & Awaited<R>
      ? K
      : never
    : never;
}[keyof ElectronAPI];
type AssertNever<T extends never> = T;
export type NoAnyReturns = AssertNever<AnyReturningMember>;
