import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_SOURCES } from './aiSources';

describe('the AI sources', () => {
  it('give a Hugging Face organization’s open weights to AI Homebrew, and a top lab’s to AI Enterprise too', () => {
    const categories = (id: string) => AI_SOURCES.find((s) => s.id === id)?.categories;
    assert.deepEqual(categories('hf-qwen'), ['ai-homebrew']);
    assert.deepEqual(categories('hf-nvidia'), ['ai-homebrew']);
    assert.deepEqual(categories('hf-deepseek-ai'), ['ai-homebrew', 'ai-enterprise']);
    assert.deepEqual(categories('hf-google'), ['ai-homebrew', 'ai-enterprise']);
  });
});
