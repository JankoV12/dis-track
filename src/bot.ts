import 'dotenv/config';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType, getVoiceConnections} from '@discordjs/voice';
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

// Try to authorise Spotify access for play‑dl
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    playdl.setToken({
        spotify: {
            client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN ?? undefined,
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

// Map of currently playing tracks, used for slash command responses
const nowPlayingMessages = new Map<string, { message: import('discord.js').Message | null, interaction: import('discord.js').CommandInteraction | null }>();
const queues: Map<string, string[]> = new Map();
const currentTracks: Map<string, TrackMetadata> = new Map();
/**
 * A simple responder type so we can share logic between prefix‑commands and slash‑commands.
 * It’s just a function that sends a string somewhere (message.reply, interaction.editReply, etc.).
 */
type Responder = (content: string) => Promise<any>;

/**
 * Core logic for the “play” request.
 * Handles: resolving the URL, queueing, connecting, and optionally starting playback.
 * Re‑used by both the text‑prefix (`!play`) and slash (`/play`) commands so the behaviour is identical.
 */
async function processPlayRequest(
    url: string,
    voiceChannel: Exclude<import('discord.js').GuildMember['voice']['channel'], null>,
    guildId: string,
    respond: Responder
): Promise<void> {
    // ---------------- main logic ----------------
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
        q.push(...playable);

        // ensure / reuse a voice connection then start playback
        let connection =
            player.subscribers.find(sub => sub.connection?.joinConfig.guildId === guildId)?.connection;
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
        if (rest.length) q.push(...rest);
    })();

    const existingConn =
        player.subscribers.find(sub => sub.connection?.joinConfig.guildId === guildId)?.connection;

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
            requester: 'Unknown',
            thumbnail: 'https://i.imgur.com/QMnXrF6.png'
        };
        currentTracks.set(guildId, metadata);

    // Load metadata
        (async () => {
            try {
                if (/open\.spotify\.com/.test(first)) {
                    const sp = await playdl.spotify(first);
                    metadata.title = sp.name;
                    metadata.artist = sp.artists.map(a => a.name).join(', ');
                    metadata.thumbnail = sp.thumbnail?.url;
                } else {
                    const info = await playdl.video_basic_info(first);
                    metadata.title = info.video_details.title;
                    metadata.artist = info.video_details.channel?.name || 'Unknown';
                    metadata.duration = info.video_details.durationRaw;
                    metadata.thumbnail = info.video_details.thumbnails[0]?.url;
                }
            } catch (err) {
                console.error('Failed to load track metadata:', err);
            }
        })();

        player.play(resource);
        await respond(`🎶 Now playing: ${first}`);
    } else {
        q.push(first);
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
        const url = q[i];
        let title = url;
        let author = '';
        try {
            if (/open\.spotify\.com/.test(url)) {
                const sp = await playdl.spotify(url);
                title = sp.name;
                author = sp.artists.join(', ');
            } else {
                const info = await playdl.video_basic_info(url);
                title = info.video_details.title;
                author = info.video_details.author?.name || '';
            }
        } catch {
            // leave title as URL on error
        }
        lines.push(`${i + 1}. **${title}** by ${author}\n\`${url}\``);
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
            const sp = await playdl.spotify(url);
            if (sp.type === 'track') {
                const sr = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
                return sr.length ? sr[0].url : null;
            }
            // playlist / album – just use the first already‑present track blob
            const firstTrack = sp.tracks[0] ?? null;
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
        } catch (err) {
            console.error('YouTube playlist resolve error:', err);
            return [];
        }
    }

    // ─── Single YouTube video ──────────────────────────────────
    if (/youtu\.?be|youtube\.com/.test(url)) return [url];

    // Spotify handling
    if (/open\.spotify\.com/.test(url)) {
        try {
            const sp = await playdl.spotify(url);
            // Single track
            if (sp.type === 'track') {
                try {
                    const search = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
                    return search.length ? [search[0].url] : [];
                } catch (err) {
                    console.error('Track search failed, skipping:', sp.name, err);
                    return [];
                }
            }
            // Playlist / Album
            if (sp.type === 'playlist' || sp.type === 'album') {
                // Load the playlist lazily: just queue the raw Spotify URLs.
                // They will be resolved to YouTube one‑by‑one in createResource().
                const all = await sp.all_tracks();
                return all.map(t => t.url as string).filter(Boolean);
            }
        } catch (err) {
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
            const sp = await playdl.spotify(url);
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
    } catch (error) {
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
    const q = queues.get(guildId);
    if (!q || q.length === 0) {
        updateEmbedToStopped(guildId);
        checkInactivity(connection);
        return;
    }

    let retryCount = 0;
    const maxRetries = 3;

    while (q.length && retryCount < maxRetries) {
        const nextUrl = q.shift()!;
        try {
            const resource = await safeCreateResource(nextUrl);
            connection.subscribe(player);

            // Store track metadata
            const metadata: TrackMetadata = {
                url: nextUrl,
                title: 'Loading...',
                artist: 'Loading...',
                duration: 'Loading...',
                requester: 'Loading...',
                thumbnail: 'https://cdn.discordapp.com/avatars/1371932098851639357/e5f72d929c24d25c4153d11f7e06c766.webp?size=1024&format=webp&width=1024&height=1024'
            };
            currentTracks.set(guildId, metadata);

            // Load metadata asynchronously
            loadTrackMetadata(nextUrl, metadata, guildId);

            player.play(resource);
            return; // success
        } catch (err) {
            if (err.message === 'RESOURCE_NOT_FOUND') {
                console.log(`⤼ Track unavailable (404), skipping: ${nextUrl}`);
                retryCount = 0; // Reset retry count for new URL
            } else {
                console.error('⤼ Failed to play track, skipping:', nextUrl, err);
                retryCount++;
            }
        }
    }

    // No playable tracks remain or max retries reached
    if (retryCount >= maxRetries) {
        console.error(`❌ Failed to play any tracks after ${maxRetries} attempts`);
    }

    updateEmbedToStopped(guildId);
    checkInactivity(connection);
}

// Helper to load metadata asynchronously
async function loadTrackMetadata(url: string, metadata: TrackMetadata, guildId: string): Promise<void> {
    try {
        if (/open\.spotify\.com/.test(url)) {
            const sp = await playdl.spotify(url);
            metadata.title = sp.name;
            metadata.artist = sp.artists.map(a => a.name).join(', ');
            metadata.thumbnail = sp.thumbnail?.url;
        } else {
            const info = await playdl.video_basic_info(url);
            metadata.title = info.video_details.title;
            metadata.artist = info.video_details.channel?.name || 'Unknown';
            metadata.duration = info.video_details.durationRaw;
            metadata.thumbnail = info.video_details.thumbnails[0]?.url;
        }

        // Update embed with new metadata
        void updateNowPlayingEmbed(guildId);
    } catch (err) {
        console.error('Failed to load track metadata:', err);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,          // required for slash‑command interactions
        GatewayIntentBits.GuildMessages,   // read messages (for prefix cmds)
        GatewayIntentBits.GuildVoiceStates, // track users' voice‑channel presence
        GatewayIntentBits.MessageContent   // read message content (privileged intent)
    ]
});

const player = createAudioPlayer();

player.on(AudioPlayerStatus.Idle, () => {
    const connection = getVoiceConnection();
    if (connection) {
        void playFromQueue(connection);
        // Start inactivity timer when queue is empty
        if (!queues.get(connection.joinConfig.guildId)?.length) {
            checkInactivity(connection);
        }
    }

    // Update all embeds
    for (const [guildId] of nowPlayingMessages.entries()) {
        void updateNowPlayingEmbed(guildId);
    }
});

player.on(AudioPlayerStatus.Playing, () => {
    const connection = getVoiceConnection();
    if (connection) {
        // Cancel inactivity timer when playback starts
        cancelInactivityCheck(connection.joinConfig.guildId);
    }

    // Update all embeds
    for (const [guildId] of nowPlayingMessages.entries()) {
        void updateNowPlayingEmbed(guildId);
    }
});

player.on(AudioPlayerStatus.Paused, () => {
    // Update all embeds
    for (const [guildId] of nowPlayingMessages.entries()) {
        void updateNowPlayingEmbed(guildId);
    }
});

// Helper to get the active voice connection
function getVoiceConnection(): import('@discordjs/voice').VoiceConnection | undefined {
    // First try: find connections that have our player subscribed
    try {
        // This is technically accessing a private property but it works
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) return connection;
    } catch {
        // Fall through to alternative methods if the above fails
    }

    // Alternative: get all connections and try to determine which one is active
    const connections = Array.from(getVoiceConnections().values());

    // If there's only one connection, that's likely our active one
    if (connections.length === 1) return connections[0];

    // Otherwise check which connection has a non-empty queue
    return connections.find(conn =>
        queues.get(conn.joinConfig.guildId)?.length > 0 ||
        currentTracks.has(conn.joinConfig.guildId)
    );
}

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // Only care about changes in the same guild
    if (oldState.guild.id !== newState.guild.id) return;

    const guildId = oldState.guild.id;
    const connection = getVoiceConnections().get(guildId);
    if (!connection) return;

    // Check if bot is in a voice channel
    const botChannel = connection.joinConfig.channelId;
    const botVoiceChannel = oldState.guild.channels.cache.get(botChannel) as import('discord.js').VoiceChannel;

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
    const row = createNowPlayingButtons();

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
    } catch (error) {
        console.error('Failed to update now playing embed:', error);
        // Remove reference if message was deleted
        nowPlayingMessages.delete(guildId);
    }
}

function createNowPlayingEmbed(guildId: string): EmbedBuilder {
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

function createNowPlayingButtons(): ActionRowBuilder<ButtonBuilder> {
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
        } catch (error) {
            console.error('Failed to clean up old embed:', error);
        }
    }

    // Create new embed and buttons
    const embed = createNowPlayingEmbed(guildId);
    const row = createNowPlayingButtons();

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
    const row = createNowPlayingButtons();

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
    } catch (error) {
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
                msg => message.reply(msg)
            );
        } catch (err) {
            console.error(err);
            await message.reply('⚠️  Skipping unplayable track.');
            const conn = player.subscribers.find(sub => sub.connection?.joinConfig.guildId === message.guild?.id)?.connection;
            if (conn) void playFromQueue(conn);
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
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await message.reply('⏸️ Paused.');
        } else {
            await message.reply('⚠️ Nothing is currently playing.');
        }
    }
    else if (message.content === '!resume') {
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await message.reply('▶️ Resumed.');
        } else {
            await message.reply('⚠️ Nothing is paused.');
        }
    }
    else if (message.content === '!skip') {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await message.reply('⏭️ Skipped.');
        } else {
            await message.reply('⚠️ Nothing to skip.');
        }
    }
    else if (message.content === '!stop') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
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
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply({ content: '⏭️ Skipped.', ephemeral: true });
        } else {
            await interaction.reply({ content: '⚠️ Nothing to skip.', ephemeral: true });
        }
    }

    else if (interaction.customId === 'music_stop') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
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
                msg => interaction.editReply(msg)
            );
        } catch (err) {
            console.error(err);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply('⚠️  Skipping unplayable track.');
            } else {
                await interaction.reply({ content: '⚠️  Skipping unplayable track.', flags: 1 << 6 });
            }
            const conn = player.subscribers.find(sub => sub.connection?.joinConfig.guildId === interaction.guild?.id)?.connection;
            if (conn) void playFromQueue(conn);
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
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await interaction.reply('⏸️ Paused.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is currently playing.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'resume') {
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await interaction.reply('▶️ Resumed.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is paused.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'skip') {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply('⏭️ Skipped.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing to skip.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'stop') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
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
    return {
        status: player.state.status,
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
    if (player.state.status === AudioPlayerStatus.Playing) {
        player.pause();
        return true;
    }
    return false;
}

export function resumePlayback(guildId: string): boolean {
    if (player.state.status === AudioPlayerStatus.Paused) {
        player.unpause();
        return true;
    }
    return false;
}

export function skipTrack(guildId: string): boolean {
    if (player.state.status !== AudioPlayerStatus.Idle) {
        player.stop();
        return true;
    }
    return false;
}

export function stopPlayback(guildId: string): boolean {
    const connection = getVoiceConnections().get(guildId);
    if (connection) {
        queues.set(guildId, []);
        player.stop();
        connection.destroy();
        updateEmbedToStopped(guildId);
        return true;
    }
    return false;
}
