import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Embedder, FactVectors, postFacts } from './embeddings';

const facts = [
  { id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' },
  { id: 'F2', text: 'Генерація в середньому на 30% швидша' },
  { id: 'F3', text: 'Модель доступна в API з сьогодні' },
];

describe('postFacts', () => {
  it('embeds a post by the facts it tells, a line each, and a post of no fact by nothing', () => {
    assert.equal(postFacts(['F3', 'F1'], facts), 'Opus 5.5 на 20% дешевший за Opus 5\nМодель доступна в API з сьогодні');
    assert.equal(postFacts([], facts), '');
  });
});

describe('FactVectors', () => {
  /** A vector along the axis of the first word the text starts with, and the texts it was asked for */
  const axes = ['Opus', 'Генерація', 'Модель', 'GTA'];
  const fake = () => {
    const asked: string[][] = [];
    const embed: Embedder = async (texts) => {
      asked.push(texts);
      return texts.map((text) => axes.map((axis) => (text.startsWith(axis) ? 1 : 0)));
    };
    return { embed, asked };
  };
  const along = (axis: string) => axes.map((a) => (a === axis ? 1 : 0));

  it('scores each story by its closest fact, the closest first', async () => {
    const { embed } = fake();
    const vectors = new FactVectors(embed);
    const stories = [
      { storyId: 1, facts: [{ text: 'GTA VI вийде 19 листопада' }] },
      { storyId: 2, facts },
    ];
    assert.deepEqual(await vectors.scores(stories, along('Генерація')), [
      { storyId: 2, similarity: 1 },
      { storyId: 1, similarity: 0 },
    ]);
  });

  it('embeds a story’s facts once, again when they change, and forgets a story no chat asked for in a month', async () => {
    const { embed, asked } = fake();
    let now = 0;
    const vectors = new FactVectors(embed, () => now);
    const story = { storyId: 2, facts };
    await vectors.scores([story], along('Opus'));
    await vectors.scores([story], along('Модель'));
    assert.equal(asked.length, 1, 'kept');
    const confirmed = { storyId: 2, facts: [...facts, { text: 'GTA VI підтвердили' }] };
    assert.deepEqual(await vectors.scores([confirmed], along('GTA')), [{ storyId: 2, similarity: 1 }]);
    assert.equal(asked.length, 2, 'the facts changed');
    assert.deepEqual(await vectors.scores([], along('GTA')), []);
    await vectors.scores([confirmed], along('GTA'));
    assert.equal(asked.length, 2, 'kept through the forward of a chat that did not hear it');
    now += 32 * 24 * 3_600_000;
    await vectors.scores([], along('GTA'));
    await vectors.scores([confirmed], along('GTA'));
    assert.equal(asked.length, 3, 'forgotten after a month nobody asked for it');
  });

  it('asks for nothing when there is nothing to embed', async () => {
    const { embed, asked } = fake();
    assert.deepEqual(await new FactVectors(embed).scores([{ storyId: 1, facts: [] }], along('Opus')), []);
    assert.equal(asked.length, 0);
  });
});
