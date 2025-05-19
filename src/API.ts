// src/api.ts
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import {
    getPlayerState,
    getCurrentTrack,
    getQueue,
    pausePlayback,
    resumePlayback,
    skipTrack,
    stopPlayback
} from './bot';

const app = express();
const PORT = process.env.API_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        player: getPlayerState()
    });
});

// Get current track
app.get('/api/now-playing/:guildId', (req, res) => {
    const { guildId } = req.params;
    const track = getCurrentTrack(guildId);

    if (!track) {
        return res.status(404).json({ error: 'No track currently playing' });
    }

    res.json(track);
});

// Get queue
app.get('/api/queue/:guildId', (req, res) => {
    const { guildId } = req.params;
    const queue = getQueue(guildId);

    res.json({
        count: queue.length,
        tracks: queue
    });
});

// Playback controls
app.post('/api/controls/:guildId/pause', (req, res) => {
    const { guildId } = req.params;
    const success = pausePlayback(guildId);

    if (success) {
        res.json({ success: true, message: 'Playback paused' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to pause playback' });
    }
});

app.post('/api/controls/:guildId/resume', (req, res) => {
    const { guildId } = req.params;
    const success = resumePlayback(guildId);

    if (success) {
        res.json({ success: true, message: 'Playback resumed' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to resume playback' });
    }
});

app.post('/api/controls/:guildId/skip', (req, res) => {
    const { guildId } = req.params;
    const success = skipTrack(guildId);

    if (success) {
        res.json({ success: true, message: 'Track skipped' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to skip track' });
    }
});

app.post('/api/controls/:guildId/stop', (req, res) => {
    const { guildId } = req.params;
    const success = stopPlayback(guildId);

    if (success) {
        res.json({ success: true, message: 'Playback stopped' });
    } else {
        res.status(400).json({ success: false, message: 'Failed to stop playback' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});