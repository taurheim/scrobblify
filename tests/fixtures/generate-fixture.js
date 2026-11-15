// Generates a test ZIP fixture with Spotify Extended Streaming History data
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const testData = [
  {
    ts: '2024-01-15T10:30:00Z',
    master_metadata_track_name: 'Bohemian Rhapsody',
    master_metadata_album_artist_name: 'Queen',
    master_metadata_album_album_name: 'A Night at the Opera',
    ms_played: 354000,
    platform: 'web_player',
  },
  {
    ts: '2024-01-15T10:36:00Z',
    master_metadata_track_name: 'Yesterday',
    master_metadata_album_artist_name: 'The Beatles',
    master_metadata_album_album_name: 'Help!',
    ms_played: 125000,
  },
  {
    ts: '2024-01-15T10:38:00Z',
    master_metadata_track_name: 'Stairway to Heaven',
    master_metadata_album_artist_name: 'Led Zeppelin',
    master_metadata_album_album_name: 'Led Zeppelin IV',
    ms_played: 482000,
  },
  // Podcast entry (should be filtered out - null track name)
  {
    ts: '2024-01-15T11:00:00Z',
    master_metadata_track_name: null,
    master_metadata_album_artist_name: null,
    master_metadata_album_album_name: null,
    ms_played: 1800000,
  },
  // Track with special characters in name
  {
    ts: '2024-01-15T11:30:00Z',
    master_metadata_track_name: 'Rock & Roll',
    master_metadata_album_artist_name: 'Led Zeppelin',
    master_metadata_album_album_name: 'Led Zeppelin IV',
    ms_played: 220000,
  },
];

const testData2 = [
  {
    ts: '2024-01-16T09:00:00Z',
    master_metadata_track_name: 'Imagine',
    master_metadata_album_artist_name: 'John Lennon',
    master_metadata_album_album_name: 'Imagine',
    ms_played: 187000,
  },
];

/**
 * A fixture big enough to qualify for the background handoff.
 *
 * The offer is gated on 2,700 remaining tracks (`MIN_TRACKS_FOR_BACKGROUND`,
 * matched in ScrobbleStep.vue and worker/src/api.ts), so the small fixture
 * above can never reach it. Dates run backwards from a year ago, well outside
 * Last.fm's acceptance window, which is what makes the queue re-tagged — the
 * state a real import of this size is in.
 *
 * Not committed: it is derived, and `npm run dev:mock -- --background`
 * regenerates it when missing.
 */
async function generateLargeFixture(count, outPath) {
  const zip = new JSZip();
  const startMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const perFile = 1000;

  for (let start = 0; start < count; start += perFile) {
    const entries = [];
    for (let i = start; i < Math.min(start + perFile, count); i += 1) {
      entries.push({
        ts: new Date(startMs + i * 210000).toISOString(),
        master_metadata_track_name: `Mock Track ${i + 1}`,
        master_metadata_album_artist_name: `Mock Artist ${(i % 40) + 1}`,
        master_metadata_album_album_name: `Mock Album ${(i % 12) + 1}`,
        ms_played: 210000,
      });
    }
    const n = Math.floor(start / perFile);
    zip.file(`Spotify Extended Streaming History/Streaming_History_Audio_Large_${n}.json`, JSON.stringify(entries));
  }

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outPath, content);
  return { path: outPath, bytes: content.length, count };
}

async function generateFixture() {
  const zip = new JSZip();
  // Prepend a UTF-8 BOM (\uFEFF) to the first file. Some real Spotify exports
  // include a BOM, which broke JSON.parse in Safari/WebKit ("Unrecognized
  // token ''"). This keeps the fixture exercising that real-world edge case.
  zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024_0.json', `\uFEFF${JSON.stringify(testData, null, 2)}`);
  zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024_1.json', JSON.stringify(testData2, null, 2));
  // Add a non-audio file that should be ignored
  zip.file('Spotify Extended Streaming History/Streaming_History_Video_2024.json', JSON.stringify([{ ts: '2024-01-15T12:00:00Z' }]));

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  const outPath = path.join(__dirname, 'test-spotify-data.zip');
  fs.writeFileSync(outPath, content);
  console.log(`Created fixture: ${outPath} (${content.length} bytes)`);
}

module.exports = { generateFixture, generateLargeFixture };

// Only when run directly, so `require`ing the large generator from dev-mock.js
// does not silently rewrite the committed fixture the test suite depends on.
if (require.main === module) {
  const large = process.argv.includes('--large');
  if (large) {
    const count = Number(process.argv[process.argv.indexOf('--large') + 1]) || 3000;
    generateLargeFixture(count, path.join(__dirname, 'test-spotify-data-large.zip'))
      .then((r) => console.log(`Created fixture: ${r.path} (${r.bytes} bytes, ${r.count} tracks)`));
  } else {
    generateFixture();
  }
}
