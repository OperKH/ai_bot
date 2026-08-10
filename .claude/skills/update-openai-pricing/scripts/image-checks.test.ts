// node --test .claude/skills/update-openai-pricing/scripts/image-checks.test.ts
//
// (add --experimental-test-coverage for a coverage table; requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import { checkDescription, extractTemplateAfter, isDescriptionClean, type ImageExpectation } from './image-checks.ts';

const MEME_EXPECTATION: ImageExpectation = {
  meme: true,
  ukrainian: true,
  maxSentences: 3,
  mentions: [
    ['НАТО'],
    ['трьох', 'троих', 'три'],
    // the punchline: without the sarcastic retort the description misses the joke
    ['всех что ли', 'всіх чи що', 'усіх чи що', 'прям всех', 'прямо всех', 'прям усіх', 'прям всіх', 'прямо всіх'],
  ],
};

const GOOD =
  'Це мем у стилі countryballs: Данія просить союзників по НАТО надіслати хоча б трьох, ' +
  'а сусіди саркастично відповідають «Че прям всех что ли?».';

describe('checking one image description', () => {
  it('passes a description that follows every rule the prompt states', (t: TestContext) => {
    const report = checkDescription(GOOD, MEME_EXPECTATION);
    t.assert.strictEqual(report.saidMeme, true);
    t.assert.strictEqual(report.ukrainian, true);
    t.assert.deepStrictEqual(report.missing, []);
    t.assert.strictEqual(report.tooLong, false);
    t.assert.strictEqual(isDescriptionClean(report), true);
  });

  it('accepts any spelling that carries the same fact across a translation', (t: TestContext) => {
    for (const wording of ['надіслати трьох', 'отправить троих', 'надіслати три бійці']) {
      const report = checkDescription(`Це мем про НАТО, ${wording}, у відповідь «прям всіх чи що?».`, MEME_EXPECTATION);
      t.assert.deepStrictEqual(report.missing, [], wording);
    }
    for (const retort of ['«Че прям всех что ли?»', 'питають, чи прям усіх', 'відповідь: прямо всіх?']) {
      const report = checkDescription(`Мем про НАТО: просять трьох, ${retort}.`, MEME_EXPECTATION);
      t.assert.deepStrictEqual(report.missing, [], retort);
    }
  });

  it('fails a description that relays the request but drops the punchline', (t: TestContext) => {
    // the joke is the retort; a summary of only the first caption line is not the meme
    const report = checkDescription(
      'Це мем: Данія просить союзників по НАТО надіслати хоча б трьох військових.',
      MEME_EXPECTATION,
    );
    t.assert.deepStrictEqual(report.missing, [
      ['всех что ли', 'всіх чи що', 'усіх чи що', 'прям всех', 'прямо всех', 'прям усіх', 'прям всіх', 'прямо всіх'],
    ]);
    t.assert.strictEqual(isDescriptionClean(report), false);
  });

  it('reports the fact that went missing, not just a failure', (t: TestContext) => {
    const report = checkDescription('Це мем про двох сусідів, які сперечаються.', MEME_EXPECTATION);
    t.assert.deepStrictEqual(report.missing, [
      ['НАТО'],
      ['трьох', 'троих', 'три'],
      ['всех что ли', 'всіх чи що', 'усіх чи що', 'прям всех', 'прямо всех', 'прям усіх', 'прям всіх', 'прямо всіх'],
    ]);
    t.assert.strictEqual(isDescriptionClean(report), false);
  });

  it('notices a meme that was not called a meme', (t: TestContext) => {
    const text = 'Данія просить НАТО надіслати трьох, сусіди відповідають «прям всіх чи що?».';
    const report = checkDescription(text, MEME_EXPECTATION);
    t.assert.strictEqual(report.saidMeme, false);
    t.assert.strictEqual(report.memeMissed, true);
    t.assert.strictEqual(isDescriptionClean(report), false);
    // the same text is clean when nothing declared the picture a meme
    t.assert.strictEqual(isDescriptionClean(checkDescription(text, { ...MEME_EXPECTATION, meme: false })), true);
  });

  it('tells Ukrainian from Russian by letters only Ukrainian has', (t: TestContext) => {
    t.assert.strictEqual(checkDescription('Це мем про НАТО і трьох.').ukrainian, true);
    t.assert.strictEqual(checkDescription('Это мем про НАТО и троих солдат.').ukrainian, false);
  });

  it('counts sentences and flags an over-long answer', (t: TestContext) => {
    const report = checkDescription('Перше. Друге. Третє. Четверте!', { maxSentences: 3 });
    t.assert.strictEqual(report.sentences, 4);
    t.assert.strictEqual(report.tooLong, true);
    t.assert.strictEqual(checkDescription('Одне речення без крапки', { maxSentences: 3 }).sentences, 1);
  });

  it('separates an empty answer from a refusal', (t: TestContext) => {
    t.assert.strictEqual(checkDescription('   ').empty, true);
    const refused = checkDescription('Вибачте, я не можу описати це зображення.');
    t.assert.strictEqual(refused.refused, true);
    t.assert.strictEqual(refused.empty, false);
    t.assert.strictEqual(isDescriptionClean(refused), false);
  });
});

describe('reading the shipped image prompt', () => {
  const source = readFileSync(new URL('../../../../src/services/openai.service.ts', import.meta.url), 'utf8');

  it('extracts the prompt describeImage actually sends', (t: TestContext) => {
    const prompt = extractTemplateAfter(source, 'async describeImage');
    t.assert.match(prompt, /Опиши це зображення/);
    t.assert.match(prompt, /Якщо це мем/, 'the rule the saidMeme check enforces');
    t.assert.match(prompt, /точно та без змін/, 'the rule the mentions check enforces');
  });

  it('fails loudly when the anchor moves', (t: TestContext) => {
    t.assert.throws(() => extractTemplateAfter(source, 'async describeSomethingElse'), /Could not find/);
    t.assert.throws(() => extractTemplateAfter('function f() { return 1; }', 'function f'), /No template literal/);
  });
});
