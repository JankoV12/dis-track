import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import axios from 'axios';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';
import yaml from 'js-yaml';
import {
    getPlayerState,
    getCurrentTrack,
    getQueue,
    pausePlayback,
    resumePlayback,
    skipTrack,
    stopPlayback,
    addToQueue
} from './bot';
import playdl from 'play-dl';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN) {
    console.error('Discord credentials are not fully set');
}

const app = express();
const PORT = process.env.API_PORT || 3000;

// Load OpenAPI spec
const swaggerPath = path.join(__dirname, '..', 'openapi.yaml');
const swaggerDocument = yaml.load(fs.readFileSync(swaggerPath, 'utf8')) as object;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/test', express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
    const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };
    if (!code || !redirectUri) {
        res.status(400).json({ error: 'Missing code or redirectUri' });
        return;
    }
    try {
        const body = new URLSearchParams({
            client_id: CLIENT_ID!,
            client_secret: CLIENT_SECRET!,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        });

        const r = await axios.post('https://discord.com/api/v10/oauth2/token', body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
        });
        res.json(r.data);
    } catch (err: any) {
        console.error(err?.response?.data || err.message);
        res.status(500).json({ error: 'Failed to exchange code' });
    }
});

app.get('/api/bot/guilds', async (_req, res) => {
    try {
        const r = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        res.json(r.data);
    } catch (err: any) {
        console.error(err?.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch guilds' });
    }
});

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

app.post<{ guildId: string }>('/api/queue/:guildId', async (req, res) => {
    const { guildId } = req.params;
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'Song URL is a required parameter' });
    }

    try {
        const success = addToQueue(guildId, url);

        if (success) {
            res.status(201).json({
                success: true,
                message: 'Song added to queue',
                url: url
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to add song to queue'
            });
        }
    } catch (error: any) {
        console.error('Error adding track to queue:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding song to queue',
            error: error.message
        });
    }
});

// Serve Swagger UI at the API root
app.use('/', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});