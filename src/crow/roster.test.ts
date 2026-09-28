import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRoster, modelLine, modelVersion } from './roster';

describe('modelLine and modelVersion', () => {
  it('split a name into its line and its version, leaving the notes out', () => {
    assert.equal(modelLine('Claude Opus 5.5'), 'claude opus');
    assert.equal(modelLine('GPT-6.5 Sol'), 'gpt sol');
    assert.equal(modelLine('Qwen 3.8 (Omni-Flash; 27B для свого заліза)'), 'qwen');
    assert.deepEqual(modelVersion('GPT-6.5 Sol'), [6, 5]);
    assert.deepEqual(modelVersion('DeepSeek-V4.1-Flash'), [4, 1]);
    assert.deepEqual(modelVersion('Qwen 3.8 (Omni-Flash; 27B для свого заліза)'), [3, 8]);
    assert.deepEqual(modelVersion('Muse Spark'), []);
  });
});

describe('mergeRoster', () => {
  it('replaces the older version of the same line and keeps the other lines', () => {
    assert.equal(mergeRoster('Claude Opus 5, Claude Fable 5.1', 'Claude Opus 5.5'), 'Claude Opus 5.5, Claude Fable 5.1');
    assert.equal(
      mergeRoster('GPT-6 Astra (старший тариф), GPT-6 Sol, GPT-6 Luna', 'GPT-6.5 Sol'),
      'GPT-6.5 Sol, GPT-6 Astra (старший тариф), GPT-6 Luna',
    );
  });

  it('puts a model of a new line in front', () => {
    assert.equal(
      mergeRoster('Claude Opus 5.5, Claude Fable 5.1', 'Claude Mythos 5.1'),
      'Claude Mythos 5.1, Claude Opus 5.5, Claude Fable 5.1',
    );
    assert.equal(mergeRoster(null, 'Grok 4.7'), 'Grok 4.7');
  });

  it('changes nothing when the entry has the model or a newer one', () => {
    assert.equal(mergeRoster('Claude Opus 5.5, Claude Fable 5.1', 'Claude Opus 5.5'), null);
    assert.equal(mergeRoster('GPT-6.5 Sol, GPT-6 Luna', 'GPT-6 Sol'), null);
  });

  it('keeps the newest four', () => {
    assert.equal(mergeRoster('A 1, B 1, C 1, D 1', 'E 1'), 'E 1, A 1, B 1, C 1');
  });
});
