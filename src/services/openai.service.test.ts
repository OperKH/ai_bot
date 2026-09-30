import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { isPassingError, isQuotaError } from './openai.service';

/** An error as the SDK builds it from a response */
const apiError = (status: number, error: Record<string, string>) =>
  OpenAI.APIError.generate(status, { error }, undefined, new Headers());

describe('isQuotaError', () => {
  it('knows an empty balance, which comes as a 429 like a rate limit', () => {
    const quota = apiError(429, {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });
    assert.equal(isQuotaError(quota), true);
    assert.equal(isQuotaError(apiError(429, { message: 'Billing hard limit', type: 'insufficient_quota', code: '' })), true);
  });

  it('leaves a rate limit and other failures alone: those pass, a top-up is not what they need', () => {
    assert.equal(isQuotaError(apiError(429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' })), false);
    assert.equal(isQuotaError(apiError(500, { message: 'Server error', type: 'server_error', code: '' })), false);
    assert.equal(isQuotaError(new Error('insufficient_quota')), false);
  });
});

describe('isPassingError', () => {
  it('knows OpenAI down or busy and a lost connection, which pass by themselves', () => {
    assert.equal(isPassingError(apiError(500, { message: 'Server error', type: 'server_error', code: '' })), true);
    assert.equal(isPassingError(apiError(503, { message: 'Overloaded', type: 'server_error', code: '' })), true);
    assert.equal(
      isPassingError(apiError(429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' })),
      true,
    );
    assert.equal(isPassingError(new OpenAI.APIConnectionTimeoutError()), true);
    assert.equal(isPassingError(new OpenAI.APIConnectionError({ message: 'Connection error.' })), true);
  });

  it('leaves what the call asked for, and an empty balance, to their own handling', () => {
    const invalidJson = apiError(400, {
      message: 'Invalid body: failed to parse JSON value',
      type: 'invalid_request_error',
      code: 'invalid_json',
    });
    assert.equal(isPassingError(invalidJson), false);
    assert.equal(
      isPassingError(apiError(429, { message: 'Quota', type: 'insufficient_quota', code: 'insufficient_quota' })),
      false,
    );
    assert.equal(isPassingError(new Error('The answer did not parse')), false);
  });
});
