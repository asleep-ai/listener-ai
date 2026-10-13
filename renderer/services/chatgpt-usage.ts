// Shared ChatGPT plan usage helpers for the Settings card, the transcription
// error dialog and the chat panels.
//
// SIWC UI guidelines: on a usage-limit error, Manage usage
// (https://chatgpt.com/settings/usage) is the primary action. Main opens the
// URL; the renderer never builds it.

// Main's ChatGPT error codes (the SIWC `subscription_sharing_*` codes with the
// prefix stripped) for which Manage usage is the useful next step.
const MANAGE_USAGE_CODES = new Set(['usage_limit_exceeded', 'usage_unavailable', 'not_eligible']);

/** Whether a ChatGPT error makes Manage usage the primary action. */
export function isChatGPTUsageLimitCode(code: string | undefined): boolean {
  if (!code) return false;
  return MANAGE_USAGE_CODES.has(code) || code.endsWith('_usage_limit_exceeded');
}

export function openChatGPTUsage(): void {
  window.electronAPI.openChatGPTUsage().catch(() => {});
}

/** A native button that opens Manage usage. */
export function createManageUsageButton(className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = 'Manage usage';
  btn.addEventListener('click', openChatGPTUsage);
  return btn;
}
