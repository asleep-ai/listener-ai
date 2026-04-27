// AI agent chat panels (home + transcription modal).
// Extracted from legacy.ts (~lines 2569-2776). Behavior preserved verbatim.
//
// Two chat views share one implementation:
//   - Home chat: scope = { kind: 'all' } (searches across every saved meeting).
//   - Modal chat: scope = { kind: 'single', folderName } (one specific meeting).
//
// During an in-flight agentChat call, the main process may emit
// 'agent-confirm-request' so the user can approve a setting change. We route
// those confirmation bubbles into whichever chat is currently awaiting a reply
// (tracked via activeChatMessagesEl).

import type { AgentChatMessage, AgentScope } from '../electronAPI';

let activeChatMessagesEl: HTMLElement | null = null;
let currentModalScope: AgentScope | null = null; // { kind: 'single', folderName } once a transcript is open

type ChatRole = 'user' | 'model' | 'system' | 'error';

type ChatControllerOptions = {
  messagesEl: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  scopeProvider: () => AgentScope | null;
  emptyEl: HTMLElement | null;
};

type ChatController = {
  submit: (question: string) => Promise<void>;
  reset: () => void;
};

function createChatController({
  messagesEl,
  form,
  input,
  sendBtn,
  scopeProvider,
  emptyEl,
}: ChatControllerOptions): ChatController {
  let history: AgentChatMessage[] = [];
  let busy = false;

  function appendMessage(
    role: ChatRole,
    text: string,
    { pending = false, html = false }: { pending?: boolean; html?: boolean } = {},
  ): HTMLElement {
    if (emptyEl?.parentNode) {
      emptyEl.remove();
    }
    const el = document.createElement('div');
    el.className = `chat-message chat-${role}${pending ? ' chat-pending' : ''}`;
    if (html) el.innerHTML = text;
    else el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // Pending bubble carries a Stop affordance so the user can bail out of a
  // set_config confirmation they no longer want to answer -- clicking it
  // rejects any in-flight confirm so the agent call unwinds and the input
  // re-enables, breaking the deadlock Gemini review flagged.
  function appendPendingBubble(): HTMLElement {
    if (emptyEl?.parentNode) emptyEl.remove();
    const el = document.createElement('div');
    el.className = 'chat-message chat-model chat-pending';
    const label = document.createElement('span');
    label.textContent = 'Thinking...';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'chat-pending-stop';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => {
      stop.disabled = true;
      window.electronAPI.cancelAgentPending();
    });
    el.appendChild(label);
    el.appendChild(stop);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  async function submit(question: string): Promise<void> {
    if (!question || busy) return;
    busy = true;
    sendBtn.disabled = true;

    appendMessage('user', question);
    input.value = '';
    const pending = appendPendingBubble();

    const priorActiveChat = activeChatMessagesEl;
    activeChatMessagesEl = messagesEl;

    try {
      const scope = scopeProvider();
      if (!scope) {
        pending.remove();
        appendMessage('error', 'No meeting context. Open a transcript first.');
        return;
      }
      const result = await window.electronAPI.agentChat({ question, history, scope });
      pending.remove();
      if (result?.success) {
        appendMessage('model', result.result.answer || '(no answer)');
        history = result.result.history || history;
        if (result.result.appliedActions && result.result.appliedActions.length > 0) {
          for (const action of result.result.appliedActions) {
            appendMessage('system', `Applied: ${action.key} = ${JSON.stringify(action.value)}`);
          }
        }
      } else {
        appendMessage('error', result?.error || 'Agent failed.');
      }
    } catch (err) {
      pending.remove();
      const message = err instanceof Error ? err.message : String(err);
      appendMessage('error', message);
    } finally {
      activeChatMessagesEl = priorActiveChat;
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(input.value.trim());
  });

  function reset(): void {
    history = [];
    messagesEl.innerHTML = '';
    if (emptyEl) messagesEl.appendChild(emptyEl);
  }

  return { submit, reset };
}

// homeChat is constructed for its side effect (the controller wires a submit
// listener on the home form); we never invoke its methods from outside.
let modalChat: ChatController | null = null;

export function setupHomeChat(): void {
  const section = document.getElementById('chatSection');
  const header = section ? section.querySelector('.chat-header') : null;
  const toggle = document.getElementById('chatToggleButton');
  const body = document.getElementById('chatBody');
  const form = document.getElementById('chatForm') as HTMLFormElement | null;
  const input = document.getElementById('chatInput') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const sendBtn = document.getElementById('chatSend') as HTMLButtonElement | null;
  const messagesEl = document.getElementById('chatMessages');
  if (!section || !header || !toggle || !body || !form || !input || !sendBtn || !messagesEl) return;

  const emptyEl = messagesEl.querySelector('.chat-empty') as HTMLElement | null;

  const doToggle = () => {
    const expanded = (body as HTMLElement).style.display !== 'none';
    (body as HTMLElement).style.display = expanded ? 'none' : 'flex';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    section.classList.toggle('expanded', !expanded);
    if (!expanded) input.focus();
  };
  header.addEventListener('click', (e) => {
    // Only toggle when clicking empty header space or the toggle button.
    if (e.target === header || e.target === toggle || e.target === header.querySelector('h2')) {
      doToggle();
    }
  });

  createChatController({
    messagesEl,
    form,
    input,
    sendBtn,
    emptyEl,
    scopeProvider: () => ({ kind: 'all' }),
  });
}

export function setupModalChat(): void {
  const form = document.getElementById('modalChatForm') as HTMLFormElement | null;
  const input = document.getElementById('modalChatInput') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const sendBtn = document.getElementById('modalChatSend') as HTMLButtonElement | null;
  const messagesEl = document.getElementById('modalChatMessages');
  if (!form || !input || !sendBtn || !messagesEl) return;

  const emptyEl = messagesEl.querySelector('.chat-empty') as HTMLElement | null;

  modalChat = createChatController({
    messagesEl,
    form,
    input,
    sendBtn,
    emptyEl,
    scopeProvider: () => currentModalScope,
  });
}

export function resetModalChatFor(folderName: string | null): void {
  currentModalScope = folderName ? { kind: 'single', folderName } : null;
  if (modalChat) modalChat.reset();
  const input = document.getElementById('modalChatInput') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const sendBtn = document.getElementById('modalChatSend') as HTMLButtonElement | null;
  if (input && sendBtn) {
    const available = !!folderName;
    input.disabled = !available;
    sendBtn.disabled = !available;
    input.placeholder = available
      ? 'Ask about this meeting...'
      : 'Transcript not saved -- ask unavailable';
  }
}

export function setupAgentConfirmHandler(): void {
  window.electronAPI.onAgentConfirmRequest(({ id, proposal }) => {
    const target = activeChatMessagesEl;
    if (!target) {
      const ok = window.confirm(`${proposal.description}\n\nApply change?`);
      window.electronAPI.sendAgentConfirmResponse({ id, approved: ok });
      return;
    }
    const el = document.createElement('div');
    el.className = 'chat-message chat-confirm';
    const desc = document.createElement('p');
    desc.textContent = proposal.description;
    el.appendChild(desc);
    const btnRow = document.createElement('div');
    btnRow.className = 'chat-confirm-buttons';
    const yes = document.createElement('button');
    yes.className = 'chat-confirm-yes';
    yes.textContent = 'Apply';
    const no = document.createElement('button');
    no.className = 'chat-confirm-no';
    no.textContent = 'Cancel';
    btnRow.appendChild(yes);
    btnRow.appendChild(no);
    el.appendChild(btnRow);
    target.appendChild(el);
    target.scrollTop = target.scrollHeight;

    const respond = (approved: boolean) => {
      yes.disabled = true;
      no.disabled = true;
      window.electronAPI.sendAgentConfirmResponse({ id, approved });
    };
    yes.addEventListener('click', () => respond(true));
    no.addEventListener('click', () => respond(false));
  });
}
