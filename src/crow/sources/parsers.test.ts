import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToText,
  parseClaudeCodeCommands,
  parseClaudeCodeWhatsNew,
  parseGeminiCliAnnouncements,
  parseHuggingFaceModels,
  parseQwenArticles,
} from './parsers';

// Trimmed from the real answers of 27.09.2026

const HUGGING_FACE = JSON.stringify([
  {
    _id: '6aaf9d29343d3bfa98cc3ba1',
    id: 'Qwen/Qwen-Image-2.1-PE-T2I',
    likes: 53,
    private: false,
    downloads: 4088,
    tags: ['safetensors', 'qwen3_5', 'text-to-image', 'license:other', 'region:us'],
    pipeline_tag: 'text-to-image',
    createdAt: '2026-09-20T08:45:29.000Z',
    modelId: 'Qwen/Qwen-Image-2.1-PE-T2I',
  },
]);

const QWEN = JSON.stringify({
  success: true,
  data: {
    articles: [
      {
        id: '8f0c',
        type: 'qwen_ai',
        title: 'Qwen-Image-2.1: Compact, Efficient, and Unified Image Creation',
        content:
          '<html><body><nav>Blog About</nav><article><p>We are excited to open-source <strong>Qwen-Image-2.1</strong>, with just 7B parameters.</p></article><footer>©</footer></body></html>',
        path: 'qwen-image-2.1',
        extra: {
          tags: ['Open-Source'],
          cover_small: 'https://img.alicdn.com/cover.png',
          date: '2026-09-20T20:00:00+08:00',
        },
      },
      {
        id: '479a',
        type: 'qwen_ai',
        title: 'SAPO: A Stable and Performant Reinforcement Learning Method',
        content: '<article><p>Paper.</p></article>',
        path: 'sapo',
        extra: { tags: ['Research'], date: '2025-12-05T04:00:00+08:00' },
      },
    ],
  },
});

const COMMANDS = `# Commands

| Command                   | Purpose                                                                                     |
| :------------------------ | :------------------------------------------------------------------------------------------ |
| \`/add-dir <path>\`         | Add a working directory for file access. Most \`.claude/\` configuration [isn't discovered](/docs/en/permissions) |
| \`/advisor [model\\|off]\`   | Enable or disable the **advisor tool**. Accepts \`fable\`, \`opus\` or \`off\`                    |

| Shortcut | What it does |
| :------- | :----------- |
| \`Esc\`    | Stops Claude |
`;

const WHATS_NEW = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item>
<title><![CDATA[Week 37]]></title>
<link>https://code.claude.com/docs/en/whats-new#week-37</link>
<guid isPermaLink="false">90d6a3d8bcc955ad</guid>
<pubDate>Tue, 15 Sep 2026 00:33:44 GMT</pubDate>
<content:encoded><![CDATA[<p><strong><code>claude plugin eval</code></strong>: run your plugin against a suite of test cases.</p>
<p><a href="https://code.claude.com/docs/en/whats-new/2026-w37">Read the Week 37 digest →</a></p>]]></content:encoded>
</item>
</channel></rss>`;

const GEMINI_CLI = `# Gemini CLI release notes

## Current releases

| Release channel | Notes |
| :-------------- | :---- |

## Announcements: v0.61.0 - 2026-09-23

- **Core Security Hardening:** Prevented indirect prompt injection
  vulnerabilities via build file modifications
  ([#29250](https://github.com/google-gemini/gemini-cli/pull/29250) by
  @villahernandez-coder).
- **Agent Loop Stability:** Preserved explicit versioned Flash model IDs
  ([#29252](https://github.com/google-gemini/gemini-cli/pull/29252) by
  @SandyTao520).
`;

describe('markdownToText', () => {
  it('keeps the text of links and drops the emphasis', () => {
    assert.equal(markdownToText('**Bold** [a link](/x) and a\\|pipe'), 'Bold a link and a|pipe');
  });
});

describe('parseHuggingFaceModels', () => {
  it('makes a new repository an entry, named and tagged, with no date to trust', () => {
    assert.deepEqual(parseHuggingFaceModels(HUGGING_FACE), [
      {
        key: 'Qwen/Qwen-Image-2.1-PE-T2I',
        title: 'Qwen/Qwen-Image-2.1-PE-T2I',
        url: 'https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I',
        summary:
          'A new open-weights model repository on Hugging Face, for text-to-image. Tags: safetensors, qwen3_5, text-to-image, license:other',
        publishedAt: null,
        imageUrl: null,
      },
    ]);
  });
});

describe('parseQwenArticles', () => {
  it('takes releases and open models, not papers, with the post as its text', () => {
    assert.deepEqual(parseQwenArticles(QWEN), [
      {
        key: '8f0c',
        title: 'Qwen-Image-2.1: Compact, Efficient, and Unified Image Creation',
        url: 'https://qwen.ai/blog?id=qwen-image-2.1',
        summary: 'We are excited to open-source Qwen-Image-2.1 , with just 7B parameters.',
        publishedAt: new Date('2026-09-20T12:00:00Z'),
        imageUrl: 'https://img.alicdn.com/cover.png',
      },
    ]);
  });
});

describe('parseClaudeCodeCommands', () => {
  it('reads the commands of the table, and nothing of the other tables', () => {
    const commands = parseClaudeCodeCommands(COMMANDS);
    assert.deepEqual(
      commands.map((command) => command.key),
      ['/add-dir', '/advisor'],
    );
    assert.deepEqual(commands[1], {
      key: '/advisor',
      title: 'New Claude Code command /advisor',
      url: 'https://code.claude.com/docs/en/changelog',
      summary: 'Enable or disable the advisor tool. Accepts `fable`, `opus` or `off`',
      publishedAt: null,
      imageUrl: null,
    });
  });
});

describe('parseClaudeCodeWhatsNew', () => {
  it("links a week to its own digest rather than to the page of all weeks", () => {
    const [week] = parseClaudeCodeWhatsNew(WHATS_NEW);
    assert.equal(week.key, '90d6a3d8bcc955ad');
    assert.equal(week.title, 'Week 37');
    assert.equal(week.url, 'https://code.claude.com/docs/en/whats-new/2026-w37');
  });
});

describe('parseGeminiCliAnnouncements', () => {
  it('reads the highlights of each stable version, without the credits of the pull requests', () => {
    assert.deepEqual(parseGeminiCliAnnouncements(GEMINI_CLI), [
      {
        key: 'v0.61.0',
        title: 'Gemini CLI v0.61.0',
        url: 'https://github.com/google-gemini/gemini-cli/releases/tag/v0.61.0',
        summary:
          '- Core Security Hardening: Prevented indirect prompt injection vulnerabilities via build file modifications.\n' +
          '- Agent Loop Stability: Preserved explicit versioned Flash model IDs.',
        publishedAt: new Date('2026-09-23T00:00:00Z'),
        imageUrl: null,
      },
    ]);
  });
});
