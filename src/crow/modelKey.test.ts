import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopicKey, normalizeVendor } from './modelKey';

describe('normalizeTopicKey', () => {
  it('puts the models of one release into one topic', () => {
    assert.equal(normalizeTopicKey('openai/gpt-6-sol', 'openai'), 'openai/gpt6');
    assert.equal(normalizeTopicKey('openai/GPT-6 Luna', 'OpenAI'), 'openai/gpt6');
    assert.equal(normalizeTopicKey('anthropic/claude-opus-5.5', 'anthropic'), 'anthropic/claude5-5');
    assert.equal(normalizeTopicKey('anthropic/claude-5.5', 'anthropic'), 'anthropic/claude5-5');
  });

  it('drops dates, snapshots and build variants', () => {
    assert.equal(normalizeTopicKey('google/gemini-3.8-flash-preview-2026-09-02', 'google'), 'google/gemini3-8');
    assert.equal(normalizeTopicKey('deepseek/deepseek-v4.1-flash-20260910', 'deepseek-ai'), 'deepseek/deepseek-v4-1');
    assert.equal(normalizeTopicKey('qwen/qwen3.8-27b-instruct-gguf', 'qwen'), 'alibaba/qwen3-8');
    assert.equal(normalizeTopicKey('deepseek-ai/DeepSeek-V4.1-Flash-NVFP4', 'deepseek'), 'deepseek/deepseek-v4-1');
  });

  it('glues a name to its version however it was written', () => {
    assert.equal(normalizeTopicKey('alibaba/qwen-3.9', 'alibaba'), normalizeTopicKey('alibaba/qwen3.9', 'alibaba'));
    assert.equal(normalizeTopicKey('meta/llama-4', 'meta'), 'meta/llama4');
  });

  it('puts the sizes of one release into one topic', () => {
    assert.equal(normalizeTopicKey('alibaba/qwen3.9-35b-a3b', 'alibaba'), 'alibaba/qwen3-9');
    assert.equal(normalizeTopicKey('google/gemma-4-e4b', 'google'), 'google/gemma4');
    assert.equal(normalizeTopicKey('huggingface/smollm4-360m', 'huggingface'), 'huggingface/smollm4');
    assert.equal(normalizeTopicKey('openai/gpt-oss-120b', 'openai'), 'openai/gpt-oss');
  });

  it('keeps product features apart from the models', () => {
    assert.equal(normalizeTopicKey('openai/chatgpt-agent-mode', 'openai'), 'openai/chatgpt-agent-mode');
    assert.equal(normalizeTopicKey('google/gemini-3.8-live', 'google'), 'google/gemini3-8-live');
  });

  it('takes the vendor from its own field, not from the key', () => {
    assert.equal(normalizeTopicKey('deepmind/gemini-3.8', 'Google DeepMind'), 'google/gemini3-8');
    assert.equal(normalizeTopicKey('grok-5', 'xAI'), 'xai/grok5');
  });
});

describe('normalizeVendor', () => {
  it('maps the names of a lab onto one', () => {
    assert.equal(normalizeVendor('Google DeepMind'), 'google');
    assert.equal(normalizeVendor('x.ai'), 'xai');
    assert.equal(normalizeVendor('moonshotai'), 'moonshot');
    assert.equal(normalizeVendor('Anthropic'), 'anthropic');
    assert.equal(normalizeVendor('zai-org'), 'zhipu');
    assert.equal(normalizeVendor('Anysphere'), 'cursor');
  });
});
