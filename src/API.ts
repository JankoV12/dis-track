import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import {
    getPlayerState,
    getCurrentTrack,
    getQueue,
    pausePlayback,
    resumePlayback,
    skipTrack,
    stopPlayback
} from './bot';
import playdl from 'play-dl';

const app = express();
const PORT = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        player: getPlayerState()
    });
});

app.get<{ guildId: string }>('/api/now-playing/:guildId', (req, res) => {
    const { guildId } = req.params;
    const track = getCurrentTrack(guildId);
    if (!track) {
        res.status(404).json({ error: 'No track currently playing' });
        return;
    }
    res.json(track);
});

app.get<{ guildId: string }>('/api/queue/:guildId', async (req, res) => {
    const { guildId } = req.params;
    const queue = getQueue(guildId);

    try {
        // Use index to track position in queue
        const formattedQueuePromises = queue.map(async (track, index) => {
            // If track is just a URL string
            if (typeof track === 'string') {
                try {
                    const info = await playdl.video_info(track);
                    const videoDetails = info.video_details;

                    return {
                        id: index + 1, // Position in queue (starting at 1)
                        title: videoDetails.title || 'Unknown Title',
                        author: videoDetails.channel?.name || 'Unknown Artist',
                        thumbnail: videoDetails.thumbnails[0]?.url || '',
                        duration: videoDetails.durationInSec || 0,
                        url: track
                    };
                } catch (err) {
                    console.error(`Error fetching metadata for ${track}:`, err);
                    return {
                        id: index + 1, // Position in queue (starting at 1)
                        title: 'Unknown Title',
                        author: 'Unknown Artist',
                        thumbnail: '',
                        duration: 0,
                        url: track
                    };
                }
            }
        });

        // Wait for all metadata to be fetched
        const formattedQueue = await Promise.all(formattedQueuePromises);

        res.json({
            count: queue.length,
            tracks: formattedQueue
        });
    } catch (error) {
        console.error('Error processing queue:', error);
        res.status(500).json({ error: 'Failed to process queue data' });
    }
});

app.post<{ guildId: string }>('/api/controls/:guildId/pause', (req, res) => {
    const { guildId } = req.params;
    const success = pausePlayback(guildId);
    if (success) {
        res.json({ success: true, message: 'Playback paused' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to pause playback' });
    }
});

app.post<{ guildId: string }>('/api/controls/:guildId/resume', (req, res) => {
    const { guildId } = req.params;
    const success = resumePlayback(guildId);
    if (success) {
        res.json({ success: true, message: 'Playback resumed' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to resume playback' });
    }
});

app.post<{ guildId: string }>('/api/controls/:guildId/skip', (req, res) => {
    const { guildId } = req.params;
    const success = skipTrack(guildId);
    if (success) {
        res.json({ success: true, message: 'Track skipped' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to skip track' });
    }
});

app.post<{ guildId: string }>('/api/controls/:guildId/stop', (req, res) => {
    const { guildId } = req.params;
    const success = stopPlayback(guildId);
    if (success) {
        res.json({ success: true, message: 'Playback stopped' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to stop playback' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'testsite.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});