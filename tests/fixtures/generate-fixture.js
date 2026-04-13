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

async function generateFixture() {
  const zip = new JSZip();
  zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024_0.json', JSON.stringify(testData, null, 2));
  zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024_1.json', JSON.stringify(testData2, null, 2));
  // Add a non-audio file that should be ignored
  zip.file('Spotify Extended Streaming History/Streaming_History_Video_2024.json', JSON.stringify([{ ts: '2024-01-15T12:00:00Z' }]));

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  const outPath = path.join(__dirname, 'test-spotify-data.zip');
  fs.writeFileSync(outPath, content);
  console.log(`Created fixture: ${outPath} (${content.length} bytes)`);
}

generateFixture();
