import spotifyUrlInfo from 'spotify-url-info';

const { getData } = spotifyUrlInfo(fetch);

export class SpotdlExtractor {
  /**
   * Fetches playlist title and all tracks in a single call.
   */
  async getPlaylist(playlistUrl) {
    if (!playlistUrl?.trim()) throw new Error('A valid Spotify playlist URL is required.');

    const cleanUrl = playlistUrl.split('?')[0];
    const data = await getData(cleanUrl);

    const title = data.title || data.name || 'Untitled Playlist';
    const items = data.trackList || data.tracks?.items || [];

    const tracks = items.map((item) => {
      const track = item.track || item;
      const author = Array.isArray(track.artists)
        ? track.artists.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')
        : track.subtitle || track.artist || 'Unknown Artist';

      return {
        title: track.title || track.name,
        author,
        durationSec: Math.round((track.duration_ms || track.duration || 0) / 1000),
        url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id || ''}`
      };
    });

    return { title, tracks };
  }
}