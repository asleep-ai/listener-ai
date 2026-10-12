import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { MODEL_PRICING } from './services/usageTracker';

// Bundle the actual renderer module with the project's compiler.
describe('renderer model options', () => {
  let options: {
    CURATED_MODELS: Record<string, readonly string[]>;
    BACKEND_DEFAULTS: Record<string, string>;
    chooseInitial(field: string, saved: string | undefined): { kind: string; value: string };
  };

  before(async () => {
    const { build } = require('vite');
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve('renderer/services/model-options.ts'), formats: ['cjs'] },
      },
    });
    const code = output[0].output.find((chunk: any) => chunk.type === 'chunk').code;
    const module = { exports: {} as any };
    vm.runInNewContext(code, { module, exports: module.exports });
    options = module.exports;
  });

  it('curates only OpenAI transcription models that usage can price', () => {
    for (const model of options.CURATED_MODELS.openaiTranscriptionModel) {
      assert.ok(MODEL_PRICING[model], `${model} has no MODEL_PRICING entry`);
    }
    assert.ok(MODEL_PRICING[options.BACKEND_DEFAULTS.openaiTranscriptionModel]);
  });

  it('keeps a saved gpt-transcribe selection as a custom model', () => {
    // Spread: the bundle's objects come from another realm.
    assert.deepEqual(
      { ...options.chooseInitial('openaiTranscriptionModel', 'gpt-transcribe') },
      {
        kind: 'custom',
        value: 'gpt-transcribe',
      },
    );
  });
});
