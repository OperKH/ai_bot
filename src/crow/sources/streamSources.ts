import type { CategoryId } from '../categories';
import { BROWSER_HEADERS, type FeedItem, HttpError } from './feed';

const MINUTE = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
/** The YouTube Data API takes this many videos in one call, at one unit of the day's 10 000 */
const YOUTUBE_BATCH = 50;
/** A channel's latest uploads read at a turn: a call is a unit at any size, and 15 cover a busy channel's 15 minutes */
const UPLOADS_READ = 15;

/**
 * Where the crow learns of a stream (docs/crow/behavior.md#streams): a YouTube
 * channel, whose scheduled live streams carry their start, or the organizer's
 * own announcement — a blog's feed, or the page Nintendo points at its current
 * Direct — whose start the model reads with its time zone.
 */
export type StreamSource = StreamSourceBase &
  (
    | {
        kind: 'youtube';
        channelId: string;
        /** Which live streams of the channel are worth a word, by title; all of them when missing */
        accept?(title: string): boolean;
      }
    | {
        kind: 'feed';
        url: string;
        /** Whether an entry may announce a stream, before the model reads it */
        mayAnnounce(item: FeedItem): boolean;
      }
    | { kind: 'redirect'; url: string }
  );

interface StreamSourceBase {
  id: string;
  name: string;
  intervalMs: number;
  categories: CategoryId[];
}

const youtube = (
  id: string,
  name: string,
  channelId: string,
  categories: CategoryId[],
  accept?: RegExp,
): StreamSource => ({
  id,
  name,
  kind: 'youtube',
  channelId,
  intervalMs: 15 * MINUTE,
  categories,
  ...(accept ? { accept: (title: string) => accept.test(title) } : {}),
});

/** A time of day with am/pm, as the announcements write it: «6:00am PT», «7am PT» */
const TIME_IN_TEXT = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b/i;

/**
 * The streams the crow announces, for the categories that have them. The game
 * channels stream every day, so only their shows count; the labs' channels
 * stream seldom, and every live stream of theirs is a launch.
 */
export const STREAM_SOURCES: readonly StreamSource[] = [
  youtube('youtube-playstation', 'PlayStation', 'UC-2Y8dQb0S6DtpxNgAKoJKA', ['playstation'], /state of play|playstation showcase/i),
  youtube('youtube-nintendo', 'Nintendo of America', 'UCGIY_O-8vW4rfX98KlMkvRg', ['nintendo'], /nintendo direct/i),
  youtube('youtube-xbox', 'Xbox', 'UCjBp_7RuDBUYbd1LegWEJ8g', ['xbox'], /xbox games showcase|xbox direct|developer direct|partner preview/i),
  youtube('youtube-openai', 'OpenAI', 'UCXZCJLdBC09xxGZ6gcdrc6A', ['ai-enterprise']),
  youtube('youtube-google', 'Google', 'UCK8sQmJBp8GCxrOtXWBpyEA', ['ai-enterprise'], /keynote|made by google|google i\/o|gemini/i),
  youtube('youtube-anthropic', 'Anthropic', 'UCrDwWp7EBBv4NwvScIpBDOA', ['ai-enterprise']),
  {
    id: 'ps-blog-state-of-play',
    name: 'PlayStation Blog',
    kind: 'feed',
    url: 'https://blog.playstation.com/tag/state-of-play/feed/',
    intervalMs: 60 * MINUTE,
    categories: ['playstation'],
    // The tag gathers the show's news too; an announcement names the show and gives its time
    mayAnnounce: (item) => /state of play|showcase/i.test(item.title) && TIME_IN_TEXT.test(item.summary),
  },
  {
    id: 'xbox-wire-showcase',
    name: 'Xbox Wire',
    kind: 'feed',
    url: 'https://news.xbox.com/en-us/tag/xbox-games-showcase/feed/',
    intervalMs: 60 * MINUTE,
    categories: ['xbox'],
    // «How to Watch» names the show and its time; the tag's other posts are its games
    mayAnnounce: (item) => /showcase|direct/i.test(item.title) && TIME_IN_TEXT.test(item.summary),
  },
  {
    id: 'nintendo-direct',
    name: 'Nintendo Direct',
    kind: 'redirect',
    url: 'https://www.nintendo.com/us/nintendo-direct/',
    intervalMs: 60 * MINUTE,
    categories: ['nintendo'],
  },
];

interface PlaylistItemsResponse {
  items?: { contentDetails?: { videoId?: string } }[];
}

/** The videos of an answer of `playlistItems?part=contentDetails` */
export function parseYouTubeUploads(body: string): string[] {
  const response = JSON.parse(body) as PlaylistItemsResponse;
  return (response.items ?? []).flatMap((item) => item.contentDetails?.videoId ?? []);
}

/**
 * A channel's latest uploads, its scheduled live streams among them: its uploads playlist is its id with `UU`
 * for `UC`. Not its RSS feed, which fails for days (docs/crow/pipeline.md#sources).
 */
export async function youtubeUploads(channelId: string, apiKey: string): Promise<string[]> {
  const params = {
    part: 'contentDetails',
    playlistId: channelId.replace(/^UC/, 'UU'),
    maxResults: String(UPLOADS_READ),
    fields: 'items/contentDetails/videoId',
  };
  return parseYouTubeUploads(await youtubeApi('playlistItems', params, apiKey));
}

/** A video as the YouTube Data API tells of it */
export interface YouTubeVideo {
  videoId: string;
  title: string;
  /** `upcoming` — scheduled, `live` — on air, `none` — a video, or a stream that is over */
  broadcast: 'upcoming' | 'live' | 'none';
  /** A live stream rather than the premiere of a recorded video, which has its length already */
  isLive: boolean;
  scheduledStart: Date | null;
}

interface VideosResponse {
  items?: {
    id: string;
    snippet?: { title?: string; liveBroadcastContent?: string };
    contentDetails?: { duration?: string };
    liveStreamingDetails?: { scheduledStartTime?: string };
  }[];
}

/** The videos of an answer of `videos?part=snippet,contentDetails,liveStreamingDetails` */
export function parseYouTubeVideos(body: string): YouTubeVideo[] {
  const response = JSON.parse(body) as VideosResponse;
  return (response.items ?? []).map((item) => {
    const broadcast = item.snippet?.liveBroadcastContent;
    const start = item.liveStreamingDetails?.scheduledStartTime;
    return {
      videoId: item.id,
      title: item.snippet?.title ?? '',
      broadcast: broadcast === 'upcoming' || broadcast === 'live' ? broadcast : 'none',
      isLive: item.contentDetails?.duration === 'P0D',
      scheduledStart: start ? new Date(start) : null,
    };
  });
}

/** What YouTube knows of the videos, a call per 50. A video that is gone is not in the answer */
export async function youtubeVideos(videoIds: readonly string[], apiKey: string): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = [];
  for (let i = 0; i < videoIds.length; i += YOUTUBE_BATCH) {
    const params = {
      part: 'snippet,contentDetails,liveStreamingDetails',
      id: videoIds.slice(i, i + YOUTUBE_BATCH).join(','),
      fields: 'items(id,snippet(title,liveBroadcastContent),contentDetails/duration,liveStreamingDetails/scheduledStartTime)',
    };
    videos.push(...parseYouTubeVideos(await youtubeApi('videos', params, apiKey)));
  }
  return videos;
}

/** A call of the YouTube Data API, `fields` cutting its answer down to what is read; the key goes in a header, off every URL */
async function youtubeApi(endpoint: string, params: Record<string, string>, apiKey: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(params)}`, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status, `from the YouTube Data API's ${endpoint}`);
  return response.text();
}

/** Where a page that points at the current thing — Nintendo's Direct — points now; null when it does not redirect */
export async function redirectTarget(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) return null;
  return new URL(location, url).href;
}
