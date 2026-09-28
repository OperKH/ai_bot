import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { arcOutline, outlineLines } from './arcOutline';

const facts = Array.from({ length: 12 }, (_, i) => ({ id: `F${i + 1}`, text: `факт ${i + 1}` }));
facts[7] = { id: 'F8', text: 'Вхідні токени коштують $4 за мільйон' };
const OPENING = 'breaking:F1+F2+F3+F4+F5+F6';

describe('arcOutline', () => {
  it('opens with the news, gives each of the other facts a message and compares after two, with no farewell', () => {
    const outline = arcOutline(facts, 12);
    assert.deepEqual(
      outline.map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7', 'practical:F8', 'versus:', 'fact:F9', 'fact:F10', 'fact:F11', 'fact:F12'],
    );
  });

  it('never tells a fact of the opening again, so a story with few facts gets a short arc', () => {
    assert.deepEqual(
      arcOutline(facts.slice(0, 2), 12).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      ['breaking:F1+F2', 'versus:'],
    );
    assert.deepEqual(
      arcOutline(facts.slice(0, 7), 12).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7', 'versus:'],
    );
  });

  it('has no comparison without competitors, a game news: the facts take its place', () => {
    assert.deepEqual(
      arcOutline(facts, 12, false).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7', 'practical:F8', 'fact:F9', 'fact:F10', 'fact:F11', 'fact:F12'],
    );
    assert.deepEqual(
      arcOutline(facts.slice(0, 2), 12, false).map((item) => item.kind),
      ['breaking'],
    );
  });

  it('marks the later third of the facts optional', () => {
    const optional = arcOutline(facts, 12)
      .filter((item) => item.optional)
      .map((item) => item.factIds[0]);
    assert.deepEqual(optional, ['F11', 'F12']);
  });

  it('tells fewer facts when the arc is shorter, keeping the most important', () => {
    assert.deepEqual(
      arcOutline(facts, 5).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7', 'practical:F8', 'versus:', 'fact:F9'],
    );
    assert.deepEqual(
      arcOutline(facts, 1).map((item) => item.kind),
      ['breaking'],
    );
  });

  it('gives a short arc the news and the next facts, with no comparison and no farewell', () => {
    assert.deepEqual(
      arcOutline(facts, 3).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7', 'practical:F8'],
    );
    assert.deepEqual(
      arcOutline(facts, 2).map((item) => `${item.kind}:${item.factIds.join('+')}`),
      [OPENING, 'fact:F7'],
    );
    // Nothing left to tell after the opening: one post
    assert.deepEqual(
      arcOutline(facts.slice(0, 6), 2).map((item) => item.kind),
      ['breaking'],
    );
    assert.ok(arcOutline(facts, 3).every((item) => !item.optional));
  });

  it('writes a numbered line per message for the prompt', () => {
    const lines = outlineLines(arcOutline(facts, 5));
    assert.equal(lines.length, 5);
    assert.match(lines[0], /^1\. \[breaking\] Прильот: головне з F1, F2, F3, F4, F5, F6 у 3–8 пунктах, до ~1500 символів/);
    assert.equal(lines[1], '2. [fact] Лише F7.');
    assert.equal(lines[2], '3. [practical] Лише F8: що з цього практично для котів.');
    assert.match(lines[3], /^4\. \[versus\] /);
    assert.equal(lines[4], '5. [fact] Лише F9.');
  });
});
