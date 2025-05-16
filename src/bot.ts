import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import {
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

    if (player.state.status === AudioPlayerStatus.Idle) {
        let connection = existingConn;
        if (!connection) {
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

/**
 * Attempt to play the next resolvable track in the queue.
 * Skips any entries that fail to create an audio resource.
 */
async function playFromQueue(connection: import('@discordjs/voice').VoiceConnection) {
    const guildId = connection.joinConfig.guildId;
    const q = queues.get(guildId);
    if (!q || q.length === 0) {
        connection.destroy();
        return;
    }

    while (q.length) {
        const nextUrl = q.shift()!;
        try {
            const resource = await createResource(nextUrl);
            connection.subscribe(player);


            // Store track metadata
            const metadata: TrackMetadata = {
                url: nextUrl,
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
                    if (/open\.spotify\.com/.test(nextUrl)) {
                        const sp = await playdl.spotify(nextUrl);
                        metadata.title = sp.name;
                        metadata.artist = sp.artists.map(a => a.name).join(', ');
                        metadata.thumbnail = sp.thumbnail?.url;
                    } else {
                        const info = await playdl.video_basic_info(nextUrl);
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
            return; // success
        } catch (err) {
            console.error('⤼  Failed to play track, skipping:', nextUrl, err);
        }
    }

    // No playable tracks remain
    connection.destroy();
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

// Destroy the connection when the player becomes idle.
player.on(AudioPlayerStatus.Idle, () => {
    const connection = player.subscribers.find(sub => sub.connection)?.connection;
    if (connection) {
        void playFromQueue(connection);
    }
});

client.once(Events.ClientReady, c => {
    console.log(`✅  Logged in as ${c.user.tag}`);
});

// simple prefix command
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
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await message.reply('⏹️ Stopped playback and cleared queue.');
        } else {
            await message.reply('⚠️ I\'m not in a voice channel.');
        }
    }
    else if (message.content === '!leave') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await message.reply('👋 Left the voice channel.');
        } else {
            await message.reply('⚠️ I\'m not in a voice channel.');
        }
    }
});



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
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
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
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await interaction.reply('⏹️ Stopped playback and cleared queue.');
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'leave') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await interaction.reply('👋 Left the voice channel.');
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'NP') {
        // Get current track info
        const guildId = interaction.guild?.id;
        if (!guildId) {
            await interaction.reply({ content: '⚠️ Cannot determine the guild.', ephemeral: true });
            return;
        }

        if (player.state.status !== AudioPlayerStatus.Playing &&
            player.state.status !== AudioPlayerStatus.Paused) {
            await interaction.reply({ content: '⚠️ Nothing is currently playing.', ephemeral: true });
            return;
        }

        // Get current track metadata
        const currentTrack = currentTracks.get(guildId) || {
            url: 'unknown',
            title: 'Unknown Track',
            artist: 'Unknown Artist',
            duration: 'Unknown',
            requester: interaction.user.tag,
            thumbnail: 'https://i.imgur.com/QMnXrF6.png'
        };

        // Get current queue to show what's playing
        const queue = queues.get(guildId) || [];

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('🎵 Now Playing')
            .setDescription(`**${currentTrack.title}** by ${currentTrack.artist}`)
            .addFields(
                { name: 'Duration', value: currentTrack.duration || 'Unknown', inline: true },
                { name: 'Requested by', value: currentTrack.requester, inline: true },
                { name: 'Queue', value: `${queue.length} tracks remaining`, inline: true }
            )
            .setThumbnail(currentTrack.thumbnail || 'https://i.imgur.com/QMnXrF6.png')
            .setFooter({ text: 'Music Bot Controls' })
            .setTimestamp();

        // Buttons
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

        // Create Action Row to hold buttons
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(playPauseButton, skipButton, stopButton);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
});

void client.login(process.env.DISCORD_TOKEN);
