import 'dotenv/config';
import { joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
    getVoiceConnections} from '@discordjs/voice';
import {
    Client,
    GatewayIntentBits,
    Events,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder} from 'discord.js';
import playdl from 'play-dl';
import ytdl from '@distube/ytdl-core';

// Optional debug flag to log skipped tracks
const LOG_SKIPPED_TRACKS = process.env.LOG_SKIPPED_TRACKS === 'true';

// Try to authorise Spotify access for play‑dl
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    playdl.setToken({
        spotify: {
            client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN as any,
            market: 'US'
        }
    });
    console.log(`🎧  Spotify credentials loaded – ${process.env.SPOTIFY_REFRESH_TOKEN ? 'full track/playlist support' : 'client‑credentials only (public tracks)'}.`);
    if (!process.env.SPOTIFY_REFRESH_TOKEN) {
        console.warn('⚠️  SPOTIFY_REFRESH_TOKEN is not set. Some private/large Spotify endpoints may fail. See README for token generation.');
    }
} else {
    console.warn('⚠️  Spotify credentials missing (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET). Spotify links will fail.');
}

interface TrackMetadata {
    url: string;
    title: string;
    artist: string;
    duration: string;
    requester: string;
    thumbnail?: string;
}

interface QueueItem {
    url: string;
    requester?: string;
}

interface CachedTrackInfo {
    title: string;
    author: string;
    thumbnail?: string;
    duration?: string;
}

const trackInfoCache = new Map<string, CachedTrackInfo>();

// Map of currently playing tracks, used for slash command responses
const nowPlayingMessages = new Map<string, { message: import('discord.js').Message | null, interaction: import('discord.js').CommandInteraction | null }>();
const queues: Map<string, QueueItem[]> = new Map();
const currentTracks: Map<string, TrackMetadata> = new Map();
const players: Map<string, import('@discordjs/voice').AudioPlayer> = new Map();
/**
 * A simple responder type so we can share logic between prefix‑commands and slash‑commands.
 * It’s just a function that sends a string somewhere (message.reply, interaction.editReply, etc.).
 */
type Responder = (content: string) => Promise<any>;

async function getCachedTrackInfo(url: string): Promise<CachedTrackInfo> {
    const cached = trackInfoCache.get(url);
    if (cached) {
        return cached;
    }
    try {
        if (/open\.spotify\.com/.test(url)) {
            const sp: any = await playdl.spotify(url);
            const info = {
                title: sp.name as string || 'Unknown',
                author: Array.isArray(sp.artists)
                    ? sp.artists.map((a: any) => a.name ?? a).join(', ')
                    : 'Unknown',
                thumbnail: sp.thumbnail?.url as string | undefined,
                duration: sp.durationRaw as string | undefined
            };
            trackInfoCache.set(url, info);
            return info;
        } else {
            const vid = await playdl.video_basic_info(url);
            const info = {
                title: vid.video_details.title || 'Unknown',
                author: vid.video_details.channel?.name || 'Unknown',
                thumbnail: vid.video_details.thumbnails[0]?.url,
                duration: vid.video_details.durationRaw
            };
            trackInfoCache.set(url, info);
            return info;
        }
    } catch (err) {
        console.error(`Error fetching metadata for ${url}:`, err);
        const info = { title: url, author: '' };
        trackInfoCache.set(url, info);
        return info;
    }
}

function getPlayer(guildId: string): import('@discordjs/voice').AudioPlayer {
    let player = players.get(guildId);
    if (!player) {
        player = createAudioPlayer();
        players.set(guildId, player);

        player.on(AudioPlayerStatus.Idle, () => {
            const connection = getVoiceConnections().get(guildId);
            if (connection) {
                void playFromQueue(connection);
                if (!queues.get(guildId)?.length) {
                    checkInactivity(connection);
                }
            }
            void updateNowPlayingEmbed(guildId);
        });

        player.on(AudioPlayerStatus.Playing, () => {
            const connection = getVoiceConnections().get(guildId);
            if (connection) {
                cancelInactivityCheck(guildId);
            }
            void updateNowPlayingEmbed(guildId);
        });

        player.on(AudioPlayerStatus.Paused, () => {
            void updateNowPlayingEmbed(guildId);
        });
    }
    return player;
}

/**
 * Core logic for the “play” request.
 * Handles: resolving the URL, queueing, connecting, and optionally starting playback.
 * Re‑used by both the text‑prefix (`!play`) and slash (`/play`) commands so the behaviour is identical.
 */
export async function processPlayRequest(
    url: string,
    voiceChannel: Exclude<import('discord.js').GuildMember['voice']['channel'], null>,
    guildId: string,
    respond: Responder,
    requester: string
): Promise<void> {
    // ---------------- main logic ----------------
    const player = getPlayer(guildId);
    const first = await resolveFirstTrack(url);

    // ── If the first track itself is unplayable … ──────────────────
    if (!first) {
        const playable = await resolveTracks(url);
        if (playable.length === 0) {
            await respond('⚠️  Couldn\'t resolve that link to a playable track.');
            return;
        }

        // push whole list to queue
        let q = queues.get(guildId);
        if (!q) { q = []; queues.set(guildId, q); }
        q.push(...playable.map(u => ({ url: u, requester })));

        // ensure / reuse a voice connection then start playback
        let connection = (player as any).subscribers.find((sub: any) => sub.connection?.joinConfig.guildId === guildId)?.connection;
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator
            });
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            } catch {
                await respond('⚠️  Couldn\'t join the voice channel.');
                return;
            }
        }
        void playFromQueue(connection);
        await respond(`📥 Added ${playable.length} track(s) to the queue (first item was unplayable).`);
        return;
    }

    // ── We have a playable "first" track ───────────────────────────
    let q = queues.get(guildId);
    if (!q) { q = []; queues.set(guildId, q); }

    // enqueue remainder of playlist/album in background
    (async () => {
        const rest = await resolveTracks(url);
        if (rest.length && rest[0] === first) rest.shift();
        if (rest.length) q.push(...rest.map(u => ({ url: u, requester })));
    })();

    const existingConn =
        (player as any).subscribers.find((sub: any) => sub.connection?.joinConfig.guildId === guildId)?.connection;

    if (player.state.status === AudioPlayerStatus.Idle || !existingConn) {
        let connection = existingConn;
        if (!connection) {
            console.log(`🔊 Creating new voice connection for ${guildId}`);
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            connection.subscribe(player);
        }
        const resource = await createResource(first);


        const metadata: TrackMetadata = {
            url: first,
            title: 'Loading...',
            artist: 'Loading...',
            duration: 'Unknown',
            requester,
            thumbnail: 'https://i.imgur.com/QMnXrF6.png'
        };
        currentTracks.set(guildId, metadata);

    // Load metadata with caching
        (async () => {
            try {
                const info = await getCachedTrackInfo(first);
                metadata.title = info.title;
                metadata.artist = info.author;
                if (info.thumbnail) metadata.thumbnail = info.thumbnail;
                if (info.duration) metadata.duration = info.duration;
            } catch (err: any) {
                console.error('Failed to load track metadata:', err);
            }
        })();

        player.play(resource);
        await respond(`🎶 Now playing: ${first}`);
    } else {
        q.push({ url: first, requester });
        await respond('📥 Added to queue.');
    }
}

/**
 * Format the current queue for display (shows up to 20 upcoming tracks).
 */
async function formatQueue(guildId: string): Promise<string> {
    const q = queues.get(guildId) ?? [];
    if (q.length === 0) return '📭 The queue is empty.';
    const lines: string[] = [];
    for (let i = 0; i < Math.min(q.length, 20); i++) {
        const item = q[i];
        const url = item.url;
        try {
            const info = await getCachedTrackInfo(url);
            lines.push(`${i + 1}. **${info.title}** by ${info.author}\n\`${url}\``);
        } catch {
            lines.push(`${i + 1}. \`${url}\``);
        }
    }
    if (q.length > 20) {
        lines.push(`…and ${q.length - 20} more`);
    }
    return '📜 **Current queue:**\n' + lines.join('\n');
}

/**
 * Quickly resolve only the first playable track from a URL.
 * Used to start playback immediately; the rest of the playlist/album
 * is fetched later in the background.
 */
async function resolveFirstTrack(url: string): Promise<string | null> {
    // YouTube playlist – get first video
    if (/youtube\.com\/.*[?&]list=/.test(url)) {
        try {
            const pl = await playdl.playlist_info(url, { incomplete: true });
            const vids = await pl.all_videos();
            return vids.length ? vids[0].url : null;
        } catch {
            return null;
        }
    }

    // Single YouTube video
    if (/youtu\.?be|youtube\.com/.test(url)) return url;

    // Spotify
    if (/open\.spotify\.com/.test(url)) {
        try {
            const sp: any = await playdl.spotify(url);
            if (sp.type === 'track') {
                const sr = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
                return sr.length ? sr[0].url : null;
            }
            // playlist / album – just use the first already‑present track blob
            const firstTrack = sp.tracks?.[0] ?? null;
            if (firstTrack) {
                const sr = await playdl.search(`${firstTrack.name} ${firstTrack.artists[0].name}`, { limit: 1 });
                return sr.length ? sr[0].url : null;
            }
        } catch {
            /* ignore */
        }
    }

    // Fallback – never return raw Spotify links (we can't stream them)
    if (/open\.spotify\.com/.test(url)) return null;
    return url || null;
}

/**
 * Resolve the given URL into one or more playable YouTube links.
 *  - YouTube links are returned as‑is.
 *  - Spotify links are mapped to YouTube via play‑dl search.
 */
async function resolveTracks(url: string): Promise<string[]> {
    // ─── YouTube playlist ──────────────────────────────────────
    // any link that contains a "list=" parameter is considered a playlist
    if (/youtube\.com\/.*[?&]list=/.test(url)) {
        try {
            const pl = await playdl.playlist_info(url, { incomplete: true });
            // pull every video URL in order
            const vids = await pl.all_videos();
            return vids.map(v => v.url);
        } catch (err: any) {
            console.error('YouTube playlist resolve error:', err);
            return [];
        }
    }

    // ─── Single YouTube video ──────────────────────────────────
    if (/youtu\.?be|youtube\.com/.test(url)) return [url];

    // Spotify handling
    if (/open\.spotify\.com/.test(url)) {
        try {
            const sp: any = await playdl.spotify(url);
            // Single track
            if (sp.type === 'track') {
                try {
                const search = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
                    return search.length ? [search[0].url] : [];
                } catch (err: any) {
                    console.error('Track search failed, skipping:', sp.name, err);
                    return [];
                }
            }
            // Playlist / Album
            if (sp.type === 'playlist' || sp.type === 'album') {
                // Load the playlist lazily: just queue the raw Spotify URLs.
                // They will be resolved to YouTube one‑by‑one in createResource().
                const all = await sp.all_tracks();
                return all.map((t: any) => t.url as string).filter(Boolean);
            }
        } catch (err: any) {
            console.error('Spotify resolve error:', err);
        }
        return [];
    }

    // Fallback – treat as single generic link (play‑dl will attempt streaming)
    return [url];
}

async function createResource(url: string) {
    // ─── Spotify fallback ───────────────────────────────────────
    // Never stream directly from Spotify; instead search YouTube/SoundCloud
    if (/open\.spotify\.com/.test(url)) {
        try {
            const sp: any = await playdl.spotify(url);
            const sr = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
            if (sr.length) {
                // recursively create a resource from the fallback URL
                return await createResource(sr[0].url);
            }
        } catch {/* fall through */}
        throw new Error('Direct Spotify streaming is not supported and no fallback was found.');
    }
    if (/youtu\.?be/.test(url)) {
        const ytStream = ytdl(url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
        });
        return createAudioResource(ytStream, { inputType: StreamType.Arbitrary });
    } else {
        const stream = await playdl.stream(url, { quality: 2 });
        return createAudioResource(stream.stream, {
            inputType: stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary
        });
    }
}

async function safeCreateResource(url: string) {
    try {
        return await createResource(url);
    } catch (error: any) {
        // Check if it's a 404 error
        if (error.message && error.message.includes('404')) {
            console.log(`⚠️ Resource not found (404): ${url}`);
            throw new Error('RESOURCE_NOT_FOUND');
        }
        throw error; // Re-throw other errors
    }
}

/**
 * Attempt to play the next resolvable track in the queue.
 * Skips any entries that fail to create an audio resource.
 */
async function playFromQueue(connection: import('@discordjs/voice').VoiceConnection) {
    const guildId = connection.joinConfig.guildId;
    const player = getPlayer(guildId);
    const q = queues.get(guildId);
    if (!q || q.length === 0) {
        updateEmbedToStopped(guildId);
        checkInactivity(connection);
        return;
    }

    let retryCount = 0;
    const maxRetries = 3;

    while (q.length) {
        const nextItem = q.shift()!;
        const nextUrl = nextItem.url;
        try {
        const resource = await safeCreateResource(nextUrl);
        connection.subscribe(player);

            // Store track metadata
            const metadata: TrackMetadata = {
                url: nextUrl,
                title: 'Loading...',
                artist: 'Loading...',
                duration: 'Loading...',
                requester: nextItem.requester || 'Unknown',
                thumbnail: 'https://cdn.discordapp.com/avatars/1371932098851639357/e5f72d929c24d25c4153d11f7e06c766.webp?size=1024&format=webp&width=1024&height=1024'
            };
            currentTracks.set(guildId, metadata);

            // Load metadata asynchronously
            loadTrackMetadata(nextUrl, metadata, guildId);

            player.play(resource);
            return; // success
        } catch (err: any) {
            if (err.message === 'RESOURCE_NOT_FOUND') {
                console.log(`⤼ Track unavailable (404), skipping: ${nextUrl}`);
                retryCount = 0; // Reset retry count for new URL
            } else {
                console.error('⤼ Failed to play track, skipping:', nextUrl, err);
                if (LOG_SKIPPED_TRACKS) {
                    console.log(`Skipped track due to error: ${nextUrl}`);
                }
                retryCount++;
                if (retryCount >= maxRetries) {
                    console.error(`❌ Reached ${maxRetries} consecutive failures. Continuing queue.`);
                    retryCount = 0;
                }
            }
        }
    }

    // No playable tracks remain
    if (retryCount > 0) {
        console.error(`❌ Failed to play any tracks after scanning the queue.`);
    }

    updateEmbedToStopped(guildId);
    checkInactivity(connection);
}

// Helper to load metadata asynchronously
async function loadTrackMetadata(url: string, metadata: TrackMetadata, guildId: string): Promise<void> {
    try {
        const info = await getCachedTrackInfo(url);
        metadata.title = info.title;
        metadata.artist = info.author;
        if (info.thumbnail) metadata.thumbnail = info.thumbnail;
        if (info.duration) metadata.duration = info.duration;

        // Update embed with new metadata
        void updateNowPlayingEmbed(guildId);
    } catch (err: any) {
        console.error('Failed to load track metadata:', err);
    }
}

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,          // required for slash‑command interactions
        GatewayIntentBits.GuildMessages,   // read messages (for prefix cmds)
        GatewayIntentBits.GuildVoiceStates, // track users' voice‑channel presence
        GatewayIntentBits.MessageContent   // read message content (privileged intent)
    ]
});


client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // Only care about changes in the same guild
    if (oldState.guild.id !== newState.guild.id) return;

    const guildId = oldState.guild.id;
    const connection = getVoiceConnections().get(guildId);
    if (!connection) return;

    // Check if bot is in a voice channel
    const botChannel = connection.joinConfig.channelId;
    const botVoiceChannel = oldState.guild.channels.cache.get(botChannel!) as import('discord.js').VoiceChannel;

    if (botVoiceChannel) {
        // Count members in the channel (excluding bots)
        const members = botVoiceChannel.members.filter(m => !m.user.bot);

        if (members.size === 0) {
            // Bot is alone, start inactivity timer
            checkInactivity(connection);
        } else {
            // Users present, cancel any disconnect timer
            cancelInactivityCheck(guildId);
        }
    }
});

client.once(Events.ClientReady, c => {
    console.log(`✅  Logged in as ${c.user.tag}`);
});


// embed update function
async function updateNowPlayingEmbed(guildId: string): Promise<void> {
    const msgData = nowPlayingMessages.get(guildId);
    if (!msgData) return;

    // Create embed
    const embed = createNowPlayingEmbed(guildId);

    // Create buttons
    const row = createNowPlayingButtons(guildId);

    // Update
    try {
        if (msgData.interaction && !msgData.interaction.ephemeral) {
            await msgData.interaction.editReply({
                embeds: [embed],
                components: [row]
            });
        } else if (msgData.message) {
            await msgData.message.edit({
                embeds: [embed],
                components: [row]
            });
        }
    } catch (error: any) {
        console.error('Failed to update now playing embed:', error);
        // Remove reference if message was deleted
        nowPlayingMessages.delete(guildId);
    }
}

function createNowPlayingEmbed(guildId: string): EmbedBuilder {
    const player = getPlayer(guildId);
    const isPlaying = player.state.status === AudioPlayerStatus.Playing ||
        player.state.status === AudioPlayerStatus.Paused;

    // Get current track metadata
    const currentTrack = currentTracks.get(guildId) || {
        url: 'unknown',
        title: 'Unknown Track',
        artist: 'Unknown Artist',
        duration: 'Unknown',
        requester: 'Unknown',
        thumbnail: 'https://i.imgur.com/QMnXrF6.png'
    };

    // Get current queue
    const queue = queues.get(guildId) || [];

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(isPlaying ? '🎵 Now Playing' : '⏹️ Not Playing')
        .setFooter({ text: 'Dis-Track Controls' })
        .setTimestamp();

    if (isPlaying) {
        embed.setDescription(`**${currentTrack.title}** by ${currentTrack.artist}`)
            .addFields(
                { name: 'Duration', value: currentTrack.duration || 'Unknown', inline: true },
                { name: 'Requested by', value: currentTrack.requester, inline: true },
                { name: 'Queue', value: `${queue.length} tracks remaining`, inline: true }
            )
            .setThumbnail(currentTrack.thumbnail || 'https://i.imgur.com/QMnXrF6.png');
    } else {
        embed.setDescription('No track is currently playing');
    }

    return embed;
}

function createNowPlayingButtons(guildId: string): ActionRowBuilder<ButtonBuilder> {
    const player = getPlayer(guildId);
    const playPauseButton = new ButtonBuilder()
        .setCustomId('music_play_pause')
        .setLabel(player.state.status === AudioPlayerStatus.Playing ? 'Pause' : 'Play')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(player.state.status === AudioPlayerStatus.Playing ? '⏸️' : '▶️');

    const skipButton = new ButtonBuilder()
        .setCustomId('music_skip')
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⏭️');

    const stopButton = new ButtonBuilder()
        .setCustomId('music_stop')
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⏹️');

    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(playPauseButton, skipButton, stopButton);
}
async function NowPlayingEmbedHandler(guildId: string, interaction?: import('discord.js').CommandInteraction): Promise<void> {
    // Check if there's an existing message/interaction
    const existing = nowPlayingMessages.get(guildId);

    // Try to clean up any existing embed
    if (existing) {
        try {
            // If there's an old interaction, try to delete it
            if (existing.interaction && !existing.interaction.ephemeral) {
                await existing.interaction.deleteReply().catch(() => {});
            }
            // If there's an old message, try to delete it
            if (existing.message) {
                await existing.message.delete().catch(() => {});
            }
        } catch (error: any) {
            console.error('Failed to clean up old embed:', error);
        }
    }

    // Create new embed and buttons
    const embed = createNowPlayingEmbed(guildId);
    const row = createNowPlayingButtons(guildId);

    // Send new embed via the provided interaction or create a new message
    if (interaction) {
        await interaction.reply({
            embeds: [embed],
            components: [row]
        });

        // Update map with new interaction
        nowPlayingMessages.set(guildId, {
            message: null,
            interaction: interaction
        });
    } else {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
        if (!channel || !channel.isTextBased()) return;

        const message = await channel.send({
            embeds: [embed],
            components: [row]
        });

        nowPlayingMessages.set(guildId, {
            message,
            interaction: null
        });
    }
}

// Update the embed to show playback has stopped
function updateEmbedToStopped(guildId: string): void {
    // Force-clear current track data
    currentTracks.delete(guildId);

    // Get the message data for this guild
    const msgData = nowPlayingMessages.get(guildId);
    if (!msgData) return;

    // Create a specific stopped embed with clear message
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('⏹️ Playback Stopped')
        .setDescription('Music playback has ended.')
        .setFooter({ text: 'Dis-Track Controls' })
        .setTimestamp();

    // Create buttons for controls
    const row = createNowPlayingButtons(guildId);

    // Update the message
    try {
        if (msgData.interaction && !msgData.interaction.ephemeral) {
            void msgData.interaction.editReply({
                embeds: [embed],
                components: [row]
            });
        } else if (msgData.message) {
            void msgData.message.edit({
                embeds: [embed],
                components: [row]
            });
        }
    } catch (error: any) {
        console.error('Failed to update stopped embed:', error);
        nowPlayingMessages.delete(guildId);
    }
}

// inactivity leave
const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

// Check and set inactivity timeout
function checkInactivity(connection: import('@discordjs/voice').VoiceConnection): void {
    const guildId = connection.joinConfig.guildId;

    // Clear any existing timeout
    const existingTimeout = disconnectTimeouts.get(guildId);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
        console.log(`🔌 Disconnecting from ${guildId} due to inactivity (3 minutes)`);
        connection.destroy();
        queues.set(guildId, []);
        disconnectTimeouts.delete(guildId);


        // void updateNowPlayingEmbed(guildId);
        updateEmbedToStopped(guildId);
    }, 180000);

    disconnectTimeouts.set(guildId, timeout);
}

// Cancel inactivity timeout if needed
function cancelInactivityCheck(guildId: string): void {
    const timeout = disconnectTimeouts.get(guildId);
    if (timeout) {
        clearTimeout(timeout);
        disconnectTimeouts.delete(guildId);
    }
}



// ! comandy handler
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.content === '!ping') {
        await message.reply('Pong! 🏓');
    }
    else if (message.content.startsWith('!play')) {
        // Strip the prefix and any leading whitespace to get the raw URL/string
        const url = message.content.replace(/^!play\s+/i, '').trim();
        if (!url) {
            await message.reply('❌ Usage: `!play <YouTube/Spotify URL>`');
            return;
        }
        const voiceChannel = message.member?.voice.channel;

        if (!voiceChannel) {
            await message.reply('❌ You need to join a voice channel first.');
            return;
        }

        try {
            await processPlayRequest(
                url,
                voiceChannel,
                voiceChannel.guild.id,
                msg => message.reply(msg),
                message.member?.displayName || message.author.username
            );
        } catch (err: any) {
            console.error(err);
            await message.reply('⚠️  Skipping unplayable track.');
            const gid = message.guild?.id;
            if (gid) {
                const player = getPlayer(gid);
                const conn = (player as any).subscribers.find((sub: any) => sub.connection?.joinConfig.guildId === gid)?.connection;
                if (conn) void playFromQueue(conn);
            }
        }
    }
    else if (message.content === '!queue') {
        const gid = message.guild?.id;
        if (gid) {
            await message.reply(await formatQueue(gid));
        } else {
            await message.reply('⚠️  I can\'t determine the guild.');
        }
    }
    else if (message.content === '!clearqueue') {
        const gid = message.guild?.id;
        if (gid) {
            queues.set(gid, []);
            await message.reply('🗑️  Cleared the queue.');
        } else {
            await message.reply('⚠️  I can\'t determine the guild.');
        }
    }
    else if (message.content === '!pause') {
        const gid = message.guild?.id;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await message.reply('⏸️ Paused.');
        } else {
            await message.reply('⚠️ Nothing is currently playing.');
        }
    }
    else if (message.content === '!resume') {
        const gid = message.guild?.id;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await message.reply('▶️ Resumed.');
        } else {
            await message.reply('⚠️ Nothing is paused.');
        }
    }
    else if (message.content === '!skip') {
        const gid = message.guild?.id;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await message.reply('⏭️ Skipped.');
        } else {
            await message.reply('⚠️ Nothing to skip.');
        }
    }
    else if (message.content === '!stop') {
        const gid = message.guild?.id;
        if (!gid) return;
        const player = getPlayer(gid);
        const connection = (player as any).subscribers.find((sub: any) => sub.connection)?.connection;
        if (connection) {
            const guildId = connection.joinConfig.guildId;
            queues.set(guildId, []);
            player.stop();
            connection.destroy();
            updateEmbedToStopped(guildId); // Add this line
            await message.reply(message.content === '!stop'
                ? '⏹️ Stopped playback and cleared queue.'
                : '👋 Left the voice channel.');
        } else {
            await message.reply('⚠️ I\'m not in a voice channel.');
        }
    }
});



// button handler
client.on(Events.InteractionCreate, async interaction => {

    if (!interaction.isButton()) return;

    if (interaction.customId === 'music_play_pause') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await interaction.reply({ content: '⏸️ Paused.', ephemeral: true });
        } else if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await interaction.reply({ content: '▶️ Resumed.', ephemeral: true });
        } else {
            await interaction.reply({ content: '⚠️ Nothing is currently playing.', ephemeral: true });
        }
    }
    else if (interaction.customId === 'music_skip') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply({ content: '⏭️ Skipped.', ephemeral: true });
        } else {
            await interaction.reply({ content: '⚠️ Nothing to skip.', ephemeral: true });
        }
    }

    else if (interaction.customId === 'music_stop') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        const connection = (player as any).subscribers.find((sub: any) => sub.connection)?.connection;
        if (connection) {
            const guildId = connection.joinConfig.guildId;
            queues.set(guildId, []);
            player.stop();
            connection.destroy();
            updateEmbedToStopped(guildId);
            await interaction.reply({ content: '⏹️ Stopped playback and cleared queue.', ephemeral: true });
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
});

// slash‑command handler
client.on(Events.InteractionCreate, async interaction  => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong! 🏓');
    }
    else if (interaction.commandName === 'play') {
        const url = interaction.options.getString('url', true);

        if (!interaction.member || !('voice' in interaction.member) || !interaction.member.voice.channel) {
            // Early exit: only to the invoker, use flags for ephemeral
            await interaction.reply({ content: '❌ You need to join a voice channel first.', flags: 1 << 6 });
            return;
        }
        const voiceChannel = interaction.member.voice.channel;

        // Defer to buy time for potentially long Spotify → YouTube lookups
        await interaction.deferReply();

        try {
            await processPlayRequest(
                url,
                voiceChannel,
                voiceChannel.guild.id,
                msg => interaction.editReply(msg),
                interaction.user.username
            );
        } catch (err: any) {
            console.error(err);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply('⚠️  Skipping unplayable track.');
            } else {
                await interaction.reply({ content: '⚠️  Skipping unplayable track.', flags: 1 << 6 });
            }
            const gid = interaction.guild?.id;
            if (gid) {
                const player = getPlayer(gid);
                const conn = (player as any).subscribers.find((sub: any) => sub.connection?.joinConfig.guildId === gid)?.connection;
                if (conn) void playFromQueue(conn);
            }
        }
    }
    else if (interaction.commandName === 'queue') {
        // Defer reply to avoid interaction timeout while formatting
        await interaction.deferReply();
        const gid = interaction.guild?.id;
        if (gid) {
            await interaction.editReply(await formatQueue(gid));
        } else {
            await interaction.editReply({ content: '⚠️  I can\'t determine the guild.', flags: 1 << 6 });
        }
    }
    else if (interaction.commandName === 'clearqueue') {
        const gid = interaction.guild?.id;
        if (gid) {
            queues.set(gid, []);
            await interaction.reply('🗑️  Cleared the queue.');
        } else {
            await interaction.reply({ content: '⚠️  I can\'t determine the guild.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'pause') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await interaction.reply('⏸️ Paused.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is currently playing.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'resume') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await interaction.reply('▶️ Resumed.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is paused.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'skip') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply('⏭️ Skipped.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing to skip.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'stop') {
        const gid = interaction.guildId;
        if (!gid) return;
        const player = getPlayer(gid);
        const connection = (player as any).subscribers.find((sub: any) => sub.connection)?.connection;
        if (connection) {
            const guildId = connection.joinConfig.guildId;
            queues.set(guildId, []);
            player.stop();
            connection.destroy();
            updateEmbedToStopped(guildId); // Add this line
            await interaction.reply(interaction.commandName === 'stop'
                ? '⏹️ Stopped playback and cleared queue.'
                : '👋 Left the voice channel.');
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'np') {
        // Get guild ID
        const guildId = interaction.guild?.id;
        if (!guildId) {
            await interaction.reply({ content: '⚠️ Cannot determine the guild.', ephemeral: true });
            return;
        }

        // Create or update embed
        await NowPlayingEmbedHandler(guildId, interaction);
    }
});

void client.login(process.env.DISCORD_TOKEN);


export function getPlayerState() {
    const statuses: Record<string, AudioPlayerStatus> = {};
    for (const [gid, player] of players.entries()) {
        statuses[gid] = player.state.status;
    }
    return {
        status: statuses,
        connections: Array.from(getVoiceConnections().keys())
    };
}

export function getCurrentTrack(guildId: string) {
    return currentTracks.get(guildId) || null;
}

export function getQueue(guildId: string) {
    return queues.get(guildId) || [];
}

export function pausePlayback(guildId: string): boolean {
    const player = players.get(guildId);
    if (player && player.state.status === AudioPlayerStatus.Playing) {
        player.pause();
        return true;
    }
    return false;
}

export function resumePlayback(guildId: string): boolean {
    const player = players.get(guildId);
    if (player && player.state.status === AudioPlayerStatus.Paused) {
        player.unpause();
        return true;
    }
    return false;
}

export function skipTrack(guildId: string): boolean {
    const player = players.get(guildId);
    if (player && player.state.status !== AudioPlayerStatus.Idle) {
        player.stop();
        return true;
    }
    return false;
}

export function stopPlayback(guildId: string): boolean {
    const connection = getVoiceConnections().get(guildId);
    const player = players.get(guildId);
    if (connection && player) {
        queues.set(guildId, []);
        player.stop();
        connection.destroy();
        updateEmbedToStopped(guildId);
        return true;
    }
    return false;
}

export async function addToQueue(guildId: string, url: string, requester?: string): Promise<boolean> {
    try {
        // Get existing queue or create new one
        let q = queues.get(guildId);
        if (!q) {
            q = [];
            queues.set(guildId, q);
        }

        // Resolve the first track to see if it's playable
        const first = await resolveFirstTrack(url);

        // If the first track isn't directly playable (e.g., a complex playlist)
        if (!first) {
            // Try to resolve all tracks from the URL
            const playable = await resolveTracks(url);
            if (playable.length === 0) {
                console.log(`Couldn't resolve ${url} to any playable tracks`);
                return false;
            }

            // Add all resolved tracks to the queue
            q.push(...playable.map(u => ({ url: u, requester: requester ?? 'Unknown' })));

            // Start playback if player is idle and a connection exists
            const player = getPlayer(guildId);
            if (player.state.status === AudioPlayerStatus.Idle) {
                const connection = getVoiceConnections().get(guildId);
                if (connection) {
                    void playFromQueue(connection);
                }
            }

            return true;
        }

        // Add first track to queue
        q.push({ url: first, requester: requester ?? 'Unknown' });

        // Process the rest of the tracks in the background if it's a playlist
        (async () => {
            const rest = await resolveTracks(url);
            // If rest contains first track, remove it to avoid duplication
            if (rest.length && rest[0] === first) rest.shift();
            if (rest.length) q.push(...rest.map(u => ({ url: u, requester: requester ?? 'Unknown' })));
        })();

        // Start playback if nothing is playing
        const player = getPlayer(guildId);
        if (player.state.status === AudioPlayerStatus.Idle) {
            const connection = getVoiceConnections().get(guildId);
            if (connection) {
                void playFromQueue(connection);
            }
        }

        return true;
    } catch (error) {
        console.error('Error adding to queue:', error);
        return false;
    }
}
