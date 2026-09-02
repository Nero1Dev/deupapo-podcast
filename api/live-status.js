// Vercel serverless function — GET /api/live-status
// Checks the YouTube channel once, caches the result for CACHE_TTL_MS,
// and serves that same cached answer to every visitor in between.
// This keeps YouTube Data API usage flat no matter how much site traffic grows,
// and keeps the API key server-side (never shipped to the browser).

const CHANNEL_ID = 'UCl9-CiyhJfiZc-7pRn5RLmQ';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15min -> max 96 YouTube calls/day, well under the 10k/day free quota

const FALLBACK = {
  live: false,
  videoId: 'lnHTEX7RX2I',
  title: 'Episódio 01 — Piloto',
  desc: 'Estreia do Deu Papo: recebemos Fabiana Agnes, estudante de Psicanálise, para uma conversa leve, aberta e cheia de reflexões sobre comportamento e saúde mental.',
  durationLabel: '⏱ 1h 30min',
  dateLabel: '26 ago 2026'
};

let cache = null; // { data, expiresAt }

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatISODuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  if (h > 0) return `${h}h ${min}min`;
  if (min > 0) return `${min}min`;
  return 'menos de 1min';
}

function formatDateBR(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS_PT[d.getMonth()]} ${d.getFullYear()}`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  return res.json();
}

async function fetchVideoMeta(apiKey, videoId) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,liveStreamingDetails&id=${videoId}&key=${apiKey}`;
  const data = await fetchJSON(url);
  const item = data.items && data.items[0];
  if (!item) return {};
  const live = !!(item.liveStreamingDetails && item.liveStreamingDetails.actualStartTime && !item.liveStreamingDetails.actualEndTime);
  if (live) {
    return { durationLabel: '🔴 transmissão em andamento', dateLabel: formatDateBR(item.liveStreamingDetails.actualStartTime) };
  }
  return {
    durationLabel: item.contentDetails ? '⏱ ' + formatISODuration(item.contentDetails.duration) : '',
    dateLabel: item.liveStreamingDetails && item.liveStreamingDetails.actualStartTime
      ? formatDateBR(item.liveStreamingDetails.actualStartTime)
      : ''
  };
}

async function resolveLiveStatus(apiKey) {
  const liveUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CHANNEL_ID}&eventType=live&type=video&key=${apiKey}`;
  const liveRes = await fetchJSON(liveUrl);

  let data;
  if (liveRes.items && liveRes.items.length) {
    const item = liveRes.items[0];
    data = { live: true, videoId: item.id.videoId, title: item.snippet.title, desc: item.snippet.description || '' };
  } else {
    const latestUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CHANNEL_ID}&order=date&type=video&maxResults=1&key=${apiKey}`;
    const latestRes = await fetchJSON(latestUrl);
    const item = latestRes.items && latestRes.items[0];
    data = item
      ? { live: false, videoId: item.id.videoId, title: item.snippet.title, desc: item.snippet.description || '' }
      : null;
  }

  if (!data) return FALLBACK;

  const meta = await fetchVideoMeta(apiKey, data.videoId);
  return { ...data, ...meta };
}

module.exports = async function handler(req, res) {
  const now = Date.now();

  if (cache && cache.expiresAt > now) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=840');
    res.status(200).json(cache.data);
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    res.status(200).json(FALLBACK);
    return;
  }

  try {
    const data = await resolveLiveStatus(apiKey);
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=840');
    res.status(200).json(data);
  } catch (e) {
    // Serve the last known-good cache if we have one, even if technically expired,
    // rather than showing an error — a stale answer beats a broken page.
    if (cache) {
      res.status(200).json(cache.data);
    } else {
      res.status(200).json(FALLBACK);
    }
  }
};
