import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, HttpError, isSourceDown, metaContent, parseFeed, parseSitemap } from './feed';

// Trimmed from the real feeds of 26.09.2026
const OPENROUTER_RSS = `<rss version="2.0"><channel>
<item>
<title><![CDATA[TypeSafe: Jev Router (typesafe/jev-router)]]></title>
<description><![CDATA[Jev Router picks the best model for each request. It runs on <a href="https://openrouter.ai/~typesafe/jev-latest">Jev</a>.]]></description>
<link>https://openrouter.ai/typesafe/jev-router</link>
<guid isPermaLink="false">typesafe/jev-router</guid>
<pubDate>Fri, 25 Sep 2026 19:12:40 GMT</pubDate>
</item>
</channel></rss>`;

const CLAUDE_NOTES_RSS = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<item><title>Claude Platform release notes — September 24, 2026</title><link>https://platform.claude.com/docs/en/release-notes/overview#september-24-2026</link><guid isPermaLink="true">https://platform.claude.com/docs/en/release-notes/overview#september-24-2026</guid><pubDate>Thu, 24 Sep 2026 00:00:00 GMT</pubDate><description>
&lt;ul&gt;
&lt;li&gt;We&apos;re resuming billing for refusals when &lt;code&gt;stop_details.category&lt;/code&gt; is &lt;code&gt;&quot;bio&quot;&lt;/code&gt;.&lt;/li&gt;
&lt;li&gt;The Compliance API is out of beta.&lt;/li&gt;
&lt;/ul&gt;</description></item>
</channel></rss>`;

const GEMINI_RSS = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title>Introducing Gemini 3.8 Live with Live Avatar</title><link>https://blog.google/gemini-3-8-live/</link><media:content height="540" medium="image" url="https://storage.googleapis.com/image.webp" width="540"/><description>&lt;img src="x.webp"&gt;Near real-time visual presence.</description><pubDate>Thu, 24 Sep 2026 15:30:00 +0000</pubDate><guid>https://blog.google/gemini-3-8-live/</guid></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>v2.1.283</title><id>tag:github.com,2008:Repository/1/v2.1.283</id>
<link rel="alternate" type="text/html" href="https://github.com/anthropics/claude-code/releases/tag/v2.1.283"/>
<updated>2026-09-25T22:00:00Z</updated><content type="html">&lt;p&gt;Added &lt;code&gt;/skill-doctor&lt;/code&gt;&lt;/p&gt;</content></entry>
</feed>`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.anthropic.com/claude-opus-5-5</loc><lastmod>2026-09-22T16:30:00.000Z</lastmod></url>
<url><loc>https://www.anthropic.com/careers</loc></url>
</urlset>`;

describe('parseFeed', () => {
  it('reads RSS entries with CDATA, keyed by the guid', () => {
    assert.deepEqual(parseFeed(OPENROUTER_RSS), [
      {
        key: 'typesafe/jev-router',
        title: 'TypeSafe: Jev Router (typesafe/jev-router)',
        url: 'https://openrouter.ai/typesafe/jev-router',
        summary: 'Jev Router picks the best model for each request. It runs on Jev .',
        publishedAt: new Date('2026-09-25T19:12:40Z'),
        imageUrl: null,
      },
    ]);
  });

  it('turns an escaped HTML description into plain text', () => {
    const [item] = parseFeed(CLAUDE_NOTES_RSS);
    assert.equal(item.title, 'Claude Platform release notes — September 24, 2026');
    assert.equal(
      item.summary,
      'We\'re resuming billing for refusals when stop_details.category is "bio" .\nThe Compliance API is out of beta.',
    );
  });

  it('takes the picture of media:content', () => {
    assert.equal(parseFeed(GEMINI_RSS)[0].imageUrl, 'https://storage.googleapis.com/image.webp');
  });

  it('reads Atom entries', () => {
    assert.deepEqual(parseFeed(ATOM), [
      {
        key: 'tag:github.com,2008:Repository/1/v2.1.283',
        title: 'v2.1.283',
        url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.283',
        summary: 'Added /skill-doctor',
        publishedAt: new Date('2026-09-25T22:00:00Z'),
        imageUrl: null,
      },
    ]);
  });

  it('throws on a document that is not XML', () => {
    assert.throws(() => parseFeed('<html><body>Just a moment...'));
  });
});

describe('parseSitemap', () => {
  it('lists the pages, titled by the last part of the path', () => {
    const [launch, careers] = parseSitemap(SITEMAP);
    assert.equal(launch.key, 'https://www.anthropic.com/claude-opus-5-5');
    assert.equal(launch.title, 'claude opus 5 5');
    assert.deepEqual(launch.publishedAt, new Date('2026-09-22T16:30:00Z'));
    assert.equal(careers.publishedAt, null);
  });
});

describe('htmlToText', () => {
  it('drops scripts and styles and decodes entities', () => {
    assert.equal(
      htmlToText('<style>p{}</style><p>Opus&nbsp;5.5 &amp; Sonnet&#39;s &#x2014; new</p><script>x()</script>'),
      "Opus 5.5 & Sonnet's — new",
    );
  });
});

describe('metaContent', () => {
  it('finds og:image whatever the order of the attributes', () => {
    const html =
      '<meta data-rh="true" property="og:image" content="https://a/card.jpeg"><meta content="T" name="og:title">';
    assert.equal(metaContent(html, 'og:image'), 'https://a/card.jpeg');
    assert.equal(metaContent(html, 'og:title'), 'T');
    assert.equal(metaContent(html, 'og:description'), null);
  });
});

describe('isSourceDown', () => {
  it('takes a server down, a limit, a timeout and no connection for the source for a while, the rest for errors', () => {
    const noConnection = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND blog.example') });
    assert.equal(isSourceDown(new HttpError(502, 'for https://blog.example/feed/')), true);
    assert.equal(isSourceDown(new HttpError(429, 'for https://blog.example/feed/')), true);
    assert.equal(isSourceDown(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
    assert.equal(isSourceDown(noConnection), true);
    assert.equal(isSourceDown(new HttpError(404, 'for https://blog.example/feed/')), false);
    assert.equal(isSourceDown(new HttpError(403, 'for https://blog.example/feed/')), false);
    assert.equal(isSourceDown(new TypeError("Cannot read properties of undefined (reading 'title')")), false);
    assert.equal(isSourceDown(new Error("The PS Store's GraphQL gave no grid")), false);
  });
});
