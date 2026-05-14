// Integration test for the pi-ai-backed agent tool-call loop.
//
// Drives AgentService end-to-end against pi-ai's faux provider so the loop's
// shape is exercised without making a real LLM call:
//   1. Faux returns a tool-call message
//   2. AgentService dispatches the tool (here: get_config)
//   3. Faux returns a final-text message
//   4. AgentService returns the assembled answer + applied actions
//
// Covers the parts of the migration that unit tests of pure helpers can't
// reach: tool definition shape (TypeBox), tool-result message construction,
// the run loop's terminator condition, and `confirm` gating for set_config.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { AgentService } from './agentService';
import { ConfigService } from './configService';
import { importEsm } from './esmImport';
import { makeTempDir, rmDir } from './test-helpers';

type PiAiModule = typeof import('@earendil-works/pi-ai');
const loadPiAi = (): Promise<PiAiModule> => importEsm<PiAiModule>('@earendil-works/pi-ai');

let workDir: string;
let configDir: string;

before(() => {
  workDir = makeTempDir('agent-piai-data');
  configDir = makeTempDir('agent-piai-config');
});

after(() => {
  rmDir(workDir);
  rmDir(configDir);
});

let registration: import('@earendil-works/pi-ai').FauxProviderRegistration | undefined;

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

// Register the faux provider against the REAL `google-generative-ai` api id so
// the API registry's google entry gets overwritten by faux's stream impl. The
// agent goes through pi-ai's `getModel('google', 'gemini-2.5-flash')` to pick
// up a real Model object (with the matching api id), but the registered
// dispatcher is faux, so no network call happens.
async function setupFauxAsGoogle(): Promise<typeof import('@earendil-works/pi-ai')> {
  const pi = await loadPiAi();
  registration = pi.registerFauxProvider({ api: 'google-generative-ai', provider: 'google' });
  return pi;
}

function makeAgent(configService: ConfigService): AgentService {
  return new AgentService({
    provider: 'gemini',
    apiKey: 'unused-for-faux',
    dataPath: workDir,
    configService,
    defaultModel: 'gemini-2.5-flash',
  });
}

describe('AgentService (pi-ai integration via faux provider)', () => {
  beforeEach(() => {
    // Reset config between tests so set_config assertions are independent.
    rmDir(configDir);
  });

  it('returns the final assistant text when no tools are called', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([pi.fauxAssistantMessage('안녕하세요. 무엇을 도와드릴까요?')]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const result = await agent.run({ question: '안녕', scope: { kind: 'all' } });

    assert.equal(result.answer, '안녕하세요. 무엇을 도와드릴까요?');
    assert.equal(result.appliedActions.length, 0);
    assert.equal(result.history.length, 2);
    assert.equal(result.history[0].role, 'user');
    assert.equal(result.history[1].role, 'model');
  });

  it('dispatches get_config and feeds the result back into a follow-up turn', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([
      pi.fauxAssistantMessage([pi.fauxToolCall('get_config', { key: 'autoMode' })], {
        stopReason: 'toolUse',
      }),
      pi.fauxAssistantMessage('autoMode is currently false.'),
    ]);

    const config = new ConfigService(configDir);
    config.setAutoMode(false);
    const agent = makeAgent(config);
    const result = await agent.run({ question: 'autoMode 값?', scope: { kind: 'all' } });

    assert.equal(result.answer, 'autoMode is currently false.');
    assert.equal(registration!.state.callCount, 2, 'expected two LLM round-trips');
  });

  it('blocks set_config when no confirm handler is wired', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([
      pi.fauxAssistantMessage([pi.fauxToolCall('set_config', { key: 'autoMode', value: 'true' })], {
        stopReason: 'toolUse',
      }),
      pi.fauxAssistantMessage('Cannot change settings in this session.'),
    ]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const result = await agent.run({ question: 'enable autoMode', scope: { kind: 'all' } });

    // The agent should NOT have applied the change -- confirm is undefined and
    // the dispatcher returns { error: 'set_config not available in this session' }.
    assert.equal(result.appliedActions.length, 0);
    assert.equal(config.getAutoMode(), false);
  });

  it('applies set_config only after the user approves', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([
      pi.fauxAssistantMessage(
        [pi.fauxToolCall('set_config', { key: 'autoMode', value: 'true', reason: 'user asked' })],
        { stopReason: 'toolUse' },
      ),
      pi.fauxAssistantMessage('autoMode is now on.'),
    ]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const proposalsSeen: unknown[] = [];
    const result = await agent.run({
      question: 'enable autoMode',
      scope: { kind: 'all' },
      confirm: async (proposal) => {
        proposalsSeen.push(proposal);
        return true;
      },
    });

    assert.equal(proposalsSeen.length, 1, 'confirm must be called once for set_config');
    assert.equal(result.appliedActions.length, 1);
    assert.deepEqual(result.appliedActions[0], {
      type: 'setConfig',
      key: 'autoMode',
      value: true,
      // ConfigService.getAllConfig() normalizes unset boolean keys to false.
      previousValue: false,
    });
    assert.equal(config.getAutoMode(), true);
  });

  it('skips set_config when the user declines', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([
      pi.fauxAssistantMessage([pi.fauxToolCall('set_config', { key: 'autoMode', value: 'true' })], {
        stopReason: 'toolUse',
      }),
      pi.fauxAssistantMessage('No change.'),
    ]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const result = await agent.run({
      question: 'enable autoMode',
      scope: { kind: 'all' },
      confirm: async () => false,
    });

    assert.equal(result.appliedActions.length, 0);
    assert.equal(config.getAutoMode(), false);
  });

  it('stops when maxSteps is exhausted and surfaces a placeholder answer', async () => {
    const pi = await setupFauxAsGoogle();
    // Queue more tool-calls than maxSteps allows.
    const toolCallStep = pi.fauxAssistantMessage(
      [pi.fauxToolCall('get_config', { key: 'autoMode' })],
      { stopReason: 'toolUse' },
    );
    registration!.setResponses([toolCallStep, toolCallStep, toolCallStep]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const result = await agent.run({
      question: 'loop',
      scope: { kind: 'all' },
      maxSteps: 2,
    });

    assert.match(result.answer, /no answer produced/);
  });

  it('replays piaiMessages across runs so prior tool use is visible', async () => {
    const pi = await setupFauxAsGoogle();
    registration!.setResponses([pi.fauxAssistantMessage('First answer.')]);

    const config = new ConfigService(configDir);
    const agent = makeAgent(config);
    const first = await agent.run({ question: 'q1', scope: { kind: 'all' } });
    const modelMsg = first.history[first.history.length - 1];
    assert.ok(modelMsg.piaiMessages && modelMsg.piaiMessages.length > 0);

    // Re-run with the history -- faux gets a longer message list this time.
    registration!.setResponses([pi.fauxAssistantMessage('Second answer.')]);
    const second = await agent.run({
      question: 'q2',
      scope: { kind: 'all' },
      history: first.history,
    });
    assert.equal(second.answer, 'Second answer.');
    // The agent must have kept the prior turns -- not just text. piaiMessages
    // from the prior model turn is replayed verbatim before the new user input.
    assert.equal(second.history.length, 4);
  });
});
