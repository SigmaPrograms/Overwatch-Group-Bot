const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType, PermissionFlagsBits } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Database setup
const db = new sqlite3.Database(path.join(__dirname, 'overwatch_bot.db'));

// Rank system configuration
const RANKS = {
    'Bronze': { divisions: [5, 4, 3, 2, 1], color: 0xCD7F32, wideGroupThreshold: 5 },
    'Silver': { divisions: [5, 4, 3, 2, 1], color: 0xC0C0C0, wideGroupThreshold: 5 },
    'Gold': { divisions: [5, 4, 3, 2, 1], color: 0xFFD700, wideGroupThreshold: 5 },
    'Platinum': { divisions: [5, 4, 3, 2, 1], color: 0x00CED1, wideGroupThreshold: 5 },
    'Diamond': { divisions: [5, 4, 3, 2, 1], color: 0xB57EDC, wideGroupThreshold: 5 },
    'Master': { divisions: [5, 4, 3, 2, 1], color: 0xFF6B35, wideGroupThreshold: 3 },
    'Grandmaster': { divisions: [5, 4, 3, 2, 1], color: 0xFF1744, wideGroupThreshold: 0 },
    'Champion': { divisions: [1], color: 0xFFD700, wideGroupThreshold: 0 }
};

const GAME_MODES = {
    '5v5': { name: '5v5 Competitive', roles: { Tank: 1, DPS: 2, Support: 2 }, total: 5 },
    '6v6': { name: '6v6 Classic', roles: { Any: 6 }, total: 6 },
    'Stadium': { name: 'Stadium Mode', roles: { Any: 6 }, total: 6 }
};

const ROLE_EMOJIS = {
    Tank: '🛡️',
    DPS: '⚔️',
    Support: '💚',
    Any: '🎮'
};

// Database initialization
function initializeDatabase() {
    db.serialize(() => {
        // Users table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            discord_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            preferred_roles TEXT,
            timezone TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // User accounts table
        db.run(`CREATE TABLE IF NOT EXISTS user_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_id TEXT,
            account_name TEXT,
            tank_rank TEXT,
            tank_division INTEGER,
            dps_rank TEXT,
            dps_division INTEGER,
            support_rank TEXT,
            support_division INTEGER,
            is_primary BOOLEAN DEFAULT 0,
            FOREIGN KEY (discord_id) REFERENCES users(discord_id)
        )`);

        // Sessions table
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_id TEXT,
            guild_id TEXT,
            channel_id TEXT,
            game_mode TEXT,
            scheduled_time DATETIME,
            timezone TEXT,
            description TEXT,
            max_rank_diff INTEGER,
            status TEXT DEFAULT 'open',
            message_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Session queue table
        db.run(`CREATE TABLE IF NOT EXISTS session_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            user_id TEXT,
            account_id INTEGER,
            preferred_roles TEXT,
            is_streaming BOOLEAN DEFAULT 0,
            queue_position INTEGER,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (account_id) REFERENCES user_accounts(id)
        )`);

        // Session participants table
        db.run(`CREATE TABLE IF NOT EXISTS session_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            user_id TEXT,
            account_id INTEGER,
            role TEXT,
            is_streaming BOOLEAN DEFAULT 0,
            selected_by TEXT,
            selected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (account_id) REFERENCES user_accounts(id)
        )`);
    });
}

// Utility functions
function getRankValue(rank, division) {
    const rankOrder = Object.keys(RANKS);
    const rankIndex = rankOrder.indexOf(rank);
    if (rankIndex === -1) return 0;
    return rankIndex * 10 + (6 - division);
}

function formatRank(rank, division) {
    return rank && division ? `${rank} ${division}` : 'Unranked';
}

async function updateSessionMessage(sessionId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM sessions WHERE id = ?`, [sessionId], async (err, session) => {
            if (err || !session) return reject(err);

            try {
                const channel = await client.channels.fetch(session.channel_id);
                const message = await channel.messages.fetch(session.message_id);

                // Get queue count
                db.get(`SELECT COUNT(*) as count FROM session_queue WHERE session_id = ?`, [sessionId], async (err, result) => {
                    const queueCount = result ? result.count : 0;

                    // Get participants
                    db.all(`SELECT sp.*, ua.account_name, ua.tank_rank, ua.tank_division, ua.dps_rank, ua.dps_division, ua.support_rank, ua.support_division 
                            FROM session_participants sp 
                            LEFT JOIN user_accounts ua ON sp.account_id = ua.id 
                            WHERE sp.session_id = ?`, [sessionId], async (err, participants) => {
                        
                        const embed = await createSessionEmbed(session, queueCount, participants || []);
                        const components = createSessionButtons(session, participants || []);
                        
                        await message.edit({ embeds: [embed], components: components });
                        resolve();
                    });
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function createSessionEmbed(session, queueCount = 0, participants = []) {
    const mode = GAME_MODES[session.game_mode];
    const scheduledTime = new Date(session.scheduled_time);
    
    const embed = new EmbedBuilder()
        .setTitle(`${mode.name} Session`)
        .setDescription(session.description || 'No description provided')
        .setColor(session.status === 'open' ? 0x0099FF : session.status === 'full' ? 0xFF6B35 : 0xFF0000)
        .addFields(
            { name: 'Scheduled Time', value: `<t:${Math.floor(scheduledTime.getTime() / 1000)}:F>`, inline: true },
            { name: 'Status', value: session.status.charAt(0).toUpperCase() + session.status.slice(1), inline: true },
            { name: 'Queue', value: `${queueCount} player${queueCount !== 1 ? 's' : ''} waiting`, inline: true }
        );

    // Add team composition
    if (mode.roles.Any) {
        const filled = participants.length;
        const slots = Array(mode.total).fill('⭕');
        for (let i = 0; i < filled; i++) {
            slots[i] = participants[i].is_streaming ? '📺' : '✅';
        }
        embed.addFields({ name: 'Team', value: slots.join(' '), inline: false });
    } else {
        let teamComp = '';
        for (const [role, count] of Object.entries(mode.roles)) {
            const roleParticipants = participants.filter(p => p.role === role);
            const filled = roleParticipants.length;
            teamComp += `${ROLE_EMOJIS[role]} ${role}: `;
            for (let i = 0; i < count; i++) {
                if (i < filled) {
                    teamComp += roleParticipants[i].is_streaming ? '📺' : '✅';
                } else {
                    teamComp += '⭕';
                }
                teamComp += ' ';
            }
            teamComp += '\n';
        }
        embed.addFields({ name: 'Team Composition', value: teamComp, inline: false });
    }

    // Add participant details
    if (participants.length > 0) {
        let participantList = '';
        participants.forEach(p => {
            const roleEmoji = ROLE_EMOJIS[p.role] || '🎮';
            const streamEmoji = p.is_streaming ? '📺' : '';
            const rank = p.role === 'Tank' ? formatRank(p.tank_rank, p.tank_division) :
                       p.role === 'DPS' ? formatRank(p.dps_rank, p.dps_division) :
                       p.role === 'Support' ? formatRank(p.support_rank, p.support_division) : 'Flex';
            participantList += `${roleEmoji} ${p.account_name} (${rank}) ${streamEmoji}\n`;
        });
        embed.addFields({ name: 'Participants', value: participantList || 'None yet', inline: false });
    }

    embed.setFooter({ text: `Session ID: ${session.id}` });
    embed.setTimestamp();

    return embed;
}

function createSessionButtons(session, participants = []) {
    const mode = GAME_MODES[session.game_mode];
    const isFull = participants.length >= mode.total;
    
    const rows = [];
    
    // Quick join buttons for role-specific modes
    if (!mode.roles.Any) {
        const roleRow = new ActionRowBuilder();
        for (const role of Object.keys(mode.roles)) {
            roleRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`quick_join_${session.id}_${role}`)
                    .setLabel(`Join as ${role}`)
                    .setEmoji(ROLE_EMOJIS[role])
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(isFull)
            );
        }
        rows.push(roleRow);
    }
    
    // General action buttons
    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`join_queue_${session.id}`)
                .setLabel('Join Queue')
                .setStyle(ButtonStyle.Success)
                .setDisabled(isFull),
            new ButtonBuilder()
                .setCustomId(`leave_queue_${session.id}`)
                .setLabel('Leave Queue')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`toggle_streaming_${session.id}`)
                .setLabel('Toggle Streaming')
                .setEmoji('📺')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`refresh_session_${session.id}`)
                .setLabel('Refresh')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`manage_team_${session.id}`)
                .setLabel('Manage Team')
                .setStyle(ButtonStyle.Primary)
        );
    
    rows.push(actionRow);
    return rows;
}

// Slash command registration
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-profile')
            .setDescription('Set up your user profile')
            .addStringOption(option =>
                option.setName('timezone')
                    .setDescription('Your timezone')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Eastern (America/New_York)', value: 'America/New_York' },
                        { name: 'Central (America/Chicago)', value: 'America/Chicago' },
                        { name: 'Mountain (America/Denver)', value: 'America/Denver' },
                        { name: 'Pacific (America/Los_Angeles)', value: 'America/Los_Angeles' },
                        { name: 'London (Europe/London)', value: 'Europe/London' },
                        { name: 'Paris (Europe/Paris)', value: 'Europe/Paris' },
                        { name: 'Tokyo (Asia/Tokyo)', value: 'Asia/Tokyo' },
                        { name: 'Seoul (Asia/Seoul)', value: 'Asia/Seoul' }
                    )),
        
        new SlashCommandBuilder()
            .setName('add-account')
            .setDescription('Add an Overwatch account')
            .addStringOption(option =>
                option.setName('account-name')
                    .setDescription('Name for this account (e.g., Main, Alt, Smurf)')
                    .setRequired(true))
            .addBooleanOption(option =>
                option.setName('is-primary')
                    .setDescription('Is this your primary account?')
                    .setRequired(false)),
        
        new SlashCommandBuilder()
            .setName('edit-account')
            .setDescription('Edit an existing account')
            .addStringOption(option =>
                option.setName('account-name')
                    .setDescription('Name of the account to edit')
                    .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName('create-session')
            .setDescription('Create a new gaming session')
            .addStringOption(option =>
                option.setName('game-mode')
                    .setDescription('Game mode for the session')
                    .setRequired(true)
                    .addChoices(
                        { name: '5v5 Competitive', value: '5v5' },
                        { name: '6v6 Classic', value: '6v6' },
                        { name: 'Stadium Mode', value: 'Stadium' }
                    ))
            .addStringOption(option =>
                option.setName('description')
                    .setDescription('Session description')
                    .setRequired(false))
            .addIntegerOption(option =>
                option.setName('max-rank-diff')
                    .setDescription('Maximum rank difference in divisions')
                    .setRequired(false)
                    .setMinValue(0)
                    .setMaxValue(50)),
        
        new SlashCommandBuilder()
            .setName('join-queue')
            .setDescription('Join a session queue')
            .addIntegerOption(option =>
                option.setName('session-id')
                    .setDescription('ID of the session to join')
                    .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName('manage-session')
            .setDescription('Manage your session (creator only)')
            .addIntegerOption(option =>
                option.setName('session-id')
                    .setDescription('ID of the session to manage')
                    .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName('view-sessions')
            .setDescription('View all active sessions'),
        
        new SlashCommandBuilder()
            .setName('my-profile')
            .setDescription('View your profile and accounts'),
        
        new SlashCommandBuilder()
            .setName('cancel-session')
            .setDescription('Cancel a session (creator only)')
            .addIntegerOption(option =>
                option.setName('session-id')
                    .setDescription('ID of the session to cancel')
                    .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName('leave-queue')
            .setDescription('Leave a session queue')
            .addIntegerOption(option =>
                option.setName('session-id')
                    .setDescription('ID of the session to leave')
                    .setRequired(true))
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Commands registered successfully!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Command handlers
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'setup-profile':
                await handleSetupProfile(interaction);
                break;
            case 'add-account':
                await handleAddAccount(interaction);
                break;
            case 'edit-account':
                await handleEditAccount(interaction);
                break;
            case 'create-session':
                await handleCreateSession(interaction);
                break;
            case 'join-queue':
                await handleJoinQueue(interaction);
                break;
            case 'manage-session':
                await handleManageSession(interaction);
                break;
            case 'view-sessions':
                await handleViewSessions(interaction);
                break;
            case 'my-profile':
                await handleMyProfile(interaction);
                break;
            case 'cancel-session':
                await handleCancelSession(interaction);
                break;
            case 'leave-queue':
                await handleLeaveQueue(interaction);
                break;
        }
    } catch (error) {
        console.error('Command error:', error);
        const errorMessage = { content: 'An error occurred while processing your command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
});

// Button interaction handlers
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, ...params] = interaction.customId.split('_');

    try {
        switch (action) {
            case 'quick':
                if (params[0] === 'join') {
                    await handleQuickJoin(interaction, params[1], params[2]);
                }
                break;
            case 'join':
                if (params[0] === 'queue') {
                    await handleJoinQueueButton(interaction, params[1]);
                }
                break;
            case 'leave':
                if (params[0] === 'queue') {
                    await handleLeaveQueueButton(interaction, params[1]);
                }
                break;
            case 'toggle':
                if (params[0] === 'streaming') {
                    await handleToggleStreaming(interaction, params[1]);
                }
                break;
            case 'refresh':
                if (params[0] === 'session') {
                    await handleRefreshSession(interaction, params[1]);
                }
                break;
            case 'manage':
                if (params[0] === 'team') {
                    await handleManageTeamButton(interaction, params[1]);
                }
                break;
        }
    } catch (error) {
        console.error('Button interaction error:', error);
        await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
    }
});

// Command handler implementations
async function handleSetupProfile(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const username = interaction.user.username;
    const timezone = interaction.options.getString('timezone') || 'America/New_York';

    // Check if user exists
    db.get(`SELECT * FROM users WHERE discord_id = ?`, [userId], (err, user) => {
        if (user) {
            // Update existing user
            db.run(`UPDATE users SET username = ?, timezone = ? WHERE discord_id = ?`,
                [username, timezone, userId], async (err) => {
                    if (err) {
                        await interaction.editReply('Error updating profile.');
                        return;
                    }

                    // Create role selection menu
                    const roleSelect = new StringSelectMenuBuilder()
                        .setCustomId('select_preferred_roles')
                        .setPlaceholder('Select your preferred roles')
                        .setMinValues(1)
                        .setMaxValues(3)
                        .addOptions([
                            { label: 'Tank', value: 'Tank', emoji: '🛡️' },
                            { label: 'DPS', value: 'DPS', emoji: '⚔️' },
                            { label: 'Support', value: 'Support', emoji: '💚' }
                        ]);

                    const row = new ActionRowBuilder().addComponents(roleSelect);

                    await interaction.editReply({
                        content: 'Profile updated! Please select your preferred roles:',
                        components: [row]
                    });
                });
        } else {
            // Create new user
            db.run(`INSERT INTO users (discord_id, username, timezone) VALUES (?, ?, ?)`,
                [userId, username, timezone], async (err) => {
                    if (err) {
                        await interaction.editReply('Error creating profile.');
                        return;
                    }

                    // Create role selection menu
                    const roleSelect = new StringSelectMenuBuilder()
                        .setCustomId('select_preferred_roles')
                        .setPlaceholder('Select your preferred roles')
                        .setMinValues(1)
                        .setMaxValues(3)
                        .addOptions([
                            { label: 'Tank', value: 'Tank', emoji: '🛡️' },
                            { label: 'DPS', value: 'DPS', emoji: '⚔️' },
                            { label: 'Support', value: 'Support', emoji: '💚' }
                        ]);

                    const row = new ActionRowBuilder().addComponents(roleSelect);

                    await interaction.editReply({
                        content: 'Profile created! Please select your preferred roles:',
                        components: [row]
                    });
                });
        }
    });
}

async function handleAddAccount(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const accountName = interaction.options.getString('account-name');
    const isPrimary = interaction.options.getBoolean('is-primary') || false;

    // Check if user exists
    db.get(`SELECT * FROM users WHERE discord_id = ?`, [userId], (err, user) => {
        if (!user) {
            interaction.editReply('Please set up your profile first using `/setup-profile`');
            return;
        }

        // Check for duplicate account name
        db.get(`SELECT * FROM user_accounts WHERE discord_id = ? AND account_name = ?`,
            [userId, accountName], (err, existing) => {
                if (existing) {
                    interaction.editReply('You already have an account with this name.');
                    return;
                }

                // If this is set as primary, unset other primary accounts
                if (isPrimary) {
                    db.run(`UPDATE user_accounts SET is_primary = 0 WHERE discord_id = ?`, [userId]);
                }

                // Insert new account
                db.run(`INSERT INTO user_accounts (discord_id, account_name, is_primary) VALUES (?, ?, ?)`,
                    [userId, accountName, isPrimary], async function(err) {
                        if (err) {
                            await interaction.editReply('Error creating account.');
                            return;
                        }

                        const accountId = this.lastID;

                        // Create rank setting buttons
                        const tankButton = new ButtonBuilder()
                            .setCustomId(`set_rank_${accountId}_Tank`)
                            .setLabel('Set Tank Rank')
                            .setEmoji('🛡️')
                            .setStyle(ButtonStyle.Primary);

                        const dpsButton = new ButtonBuilder()
                            .setCustomId(`set_rank_${accountId}_DPS`)
                            .setLabel('Set DPS Rank')
                            .setEmoji('⚔️')
                            .setStyle(ButtonStyle.Primary);

                        const supportButton = new ButtonBuilder()
                            .setCustomId(`set_rank_${accountId}_Support`)
                            .setLabel('Set Support Rank')
                            .setEmoji('💚')
                            .setStyle(ButtonStyle.Primary);

                        const row = new ActionRowBuilder()
                            .addComponents(tankButton, dpsButton, supportButton);

                        await interaction.editReply({
                            content: `Account "${accountName}" created successfully! Please set your ranks:`,
                            components: [row]
                        });
                    });
            });
    });
}

async function handleCreateSession(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const gameMode = interaction.options.getString('game-mode');
    const description = interaction.options.getString('description') || null;
    const maxRankDiff = interaction.options.getInteger('max-rank-diff') || 50;

    // Get user's timezone
    db.get(`SELECT timezone FROM users WHERE discord_id = ?`, [userId], async (err, user) => {
        const timezone = user?.timezone || 'America/New_York';

        // Create day selection menu
        const daySelect = new StringSelectMenuBuilder()
            .setCustomId(`select_day_${gameMode}_${maxRankDiff}`)
            .setPlaceholder('Select day')
            .addOptions([
                { label: 'Today', value: 'today' },
                { label: 'Tomorrow', value: 'tomorrow' },
                { label: 'Monday', value: 'monday' },
                { label: 'Tuesday', value: 'tuesday' },
                { label: 'Wednesday', value: 'wednesday' },
                { label: 'Thursday', value: 'thursday' },
                { label: 'Friday', value: 'friday' },
                { label: 'Saturday', value: 'saturday' },
                { label: 'Sunday', value: 'sunday' }
            ]);

        const row = new ActionRowBuilder().addComponents(daySelect);

        // Store description temporarily
        if (description) {
            client.tempData = client.tempData || {};
            client.tempData[userId] = { description };
        }

        await interaction.editReply({
            content: 'Please select the day for your session:',
            components: [row]
        });
    });
}

async function handleViewSessions(interaction) {
    await interaction.deferReply();

    db.all(`SELECT s.*, COUNT(sq.id) as queue_count 
            FROM sessions s 
            LEFT JOIN session_queue sq ON s.id = sq.session_id 
            WHERE s.status = 'open' AND s.guild_id = ? 
            GROUP BY s.id 
            ORDER BY s.scheduled_time ASC 
            LIMIT 10`, [interaction.guild.id], async (err, sessions) => {
        
        if (err || !sessions || sessions.length === 0) {
            await interaction.editReply('No active sessions found.');
            return;
        }

        const embeds = [];
        for (const session of sessions) {
            // Get participants for this session
            const participants = await new Promise((resolve) => {
                db.all(`SELECT * FROM session_participants WHERE session_id = ?`, [session.id], (err, rows) => {
                    resolve(rows || []);
                });
            });

            const embed = await createSessionEmbed(session, session.queue_count, participants);
            embeds.push(embed);
        }

        await interaction.editReply({ embeds: embeds.slice(0, 10) });
    });
}

async function handleMyProfile(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    db.get(`SELECT * FROM users WHERE discord_id = ?`, [userId], (err, user) => {
        if (!user) {
            interaction.editReply('You don\'t have a profile yet. Use `/setup-profile` to create one.');
            return;
        }

        db.all(`SELECT * FROM user_accounts WHERE discord_id = ? ORDER BY is_primary DESC, id ASC`,
            [userId], async (err, accounts) => {
                
                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.user.username}'s Profile`)
                    .setColor(0x0099FF)
                    .setThumbnail(interaction.user.displayAvatarURL())
                    .addFields(
                        { name: 'Timezone', value: user.timezone || 'Not set', inline: true },
                        { name: 'Preferred Roles', value: user.preferred_roles ? JSON.parse(user.preferred_roles).join(', ') : 'Not set', inline: true }
                    );

                if (accounts && accounts.length > 0) {
                    let accountList = '';
                    accounts.forEach(acc => {
                        accountList += `**${acc.account_name}** ${acc.is_primary ? '⭐' : ''}\n`;
                        accountList += `${ROLE_EMOJIS.Tank} Tank: ${formatRank(acc.tank_rank, acc.tank_division)}\n`;
                        accountList += `${ROLE_EMOJIS.DPS} DPS: ${formatRank(acc.dps_rank, acc.dps_division)}\n`;
                        accountList += `${ROLE_EMOJIS.Support} Support: ${formatRank(acc.support_rank, acc.support_division)}\n\n`;
                    });
                    embed.addFields({ name: 'Accounts', value: accountList || 'None', inline: false });
                } else {
                    embed.addFields({ name: 'Accounts', value: 'No accounts added yet', inline: false });
                }

                const editButton = new ButtonBuilder()
                    .setCustomId('edit_profile')
                    .setLabel('Edit Profile')
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(editButton);

                await interaction.editReply({ embeds: [embed], components: [row] });
            });
    });
}

// Dropdown menu handlers
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu()) return;

    const customId = interaction.customId;

    try {
        if (customId === 'select_preferred_roles') {
            const roles = interaction.values;
            const userId = interaction.user.id;

            db.run(`UPDATE users SET preferred_roles = ? WHERE discord_id = ?`,
                [JSON.stringify(roles), userId], async (err) => {
                    if (err) {
                        await interaction.reply({ content: 'Error updating roles.', ephemeral: true });
                        return;
                    }

                    await interaction.update({
                        content: `Profile setup complete! Your preferred roles: ${roles.join(', ')}`,
                        components: []
                    });
                });
        } else if (customId.startsWith('select_day_')) {
            await handleDaySelection(interaction);
        } else if (customId.startsWith('select_time_')) {
            await handleTimeSelection(interaction);
        } else if (customId.startsWith('select_rank_')) {
            await handleRankSelection(interaction);
        } else if (customId.startsWith('select_division_')) {
            await handleDivisionSelection(interaction);
        }
    } catch (error) {
        console.error('Select menu error:', error);
        await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    }
});

async function handleDaySelection(interaction) {
    const [, , gameMode, maxRankDiff] = interaction.customId.split('_');
    const selectedDay = interaction.values[0];
    const userId = interaction.user.id;

    // Calculate the date based on selection
    const now = new Date();
    let targetDate = new Date();

    if (selectedDay === 'today') {
        // Keep today's date
    } else if (selectedDay === 'tomorrow') {
        targetDate.setDate(targetDate.getDate() + 1);
    } else {
        // Find next occurrence of the selected day
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDayIndex = days.indexOf(selectedDay);
        const currentDayIndex = now.getDay();
        
        let daysToAdd = targetDayIndex - currentDayIndex;
        if (daysToAdd <= 0) daysToAdd += 7;
        
        targetDate.setDate(targetDate.getDate() + daysToAdd);
    }

    // Create time selection menus (split into AM and PM)
    const amTimes = [];
    const pmTimes = [];

    for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const displayTime = new Date();
            displayTime.setHours(hour, minute, 0, 0);
            const label = displayTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            
            if (hour < 12) {
                amTimes.push({ label, value: timeStr });
            } else {
                pmTimes.push({ label, value: timeStr });
            }
        }
    }

    const amSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_time_am_${gameMode}_${maxRankDiff}_${targetDate.toISOString().split('T')[0]}`)
        .setPlaceholder('Select AM time')
        .addOptions(amTimes.slice(0, 25)); // Discord limit is 25 options

    const pmSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_time_pm_${gameMode}_${maxRankDiff}_${targetDate.toISOString().split('T')[0]}`)
        .setPlaceholder('Select PM time')
        .addOptions(pmTimes.slice(0, 25));

    const row1 = new ActionRowBuilder().addComponents(amSelect);
    const row2 = new ActionRowBuilder().addComponents(pmSelect);

    await interaction.update({
        content: `Selected ${selectedDay}. Please choose a time:`,
        components: [row1, row2]
    });
}

async function handleTimeSelection(interaction) {
    const parts = interaction.customId.split('_');
    const gameMode = parts[3];
    const maxRankDiff = parseInt(parts[4]);
    const dateStr = parts[5];
    const selectedTime = interaction.values[0];
    const userId = interaction.user.id;

    // Get user's timezone
    const user = await new Promise((resolve) => {
        db.get(`SELECT timezone FROM users WHERE discord_id = ?`, [userId], (err, row) => {
            resolve(row);
        });
    });

    const timezone = user?.timezone || 'America/New_York';

    // Combine date and time
    const [hour, minute] = selectedTime.split(':');
    const scheduledTime = new Date(dateStr);
    scheduledTime.setHours(parseInt(hour), parseInt(minute), 0, 0);

    // Get stored description
    const description = client.tempData?.[userId]?.description || null;

    // Create the session
    db.run(`INSERT INTO sessions (creator_id, guild_id, channel_id, game_mode, scheduled_time, timezone, description, max_rank_diff) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, interaction.guild.id, interaction.channel.id, gameMode, scheduledTime.toISOString(), timezone, description, maxRankDiff],
        async function(err) {
            if (err) {
                await interaction.update({ content: 'Error creating session.', components: [] });
                return;
            }

            const sessionId = this.lastID;

            // Create session embed
            const session = {
                id: sessionId,
                game_mode: gameMode,
                scheduled_time: scheduledTime.toISOString(),
                description: description,
                status: 'open',
                max_rank_diff: maxRankDiff
            };

            const embed = await createSessionEmbed(session);
            const components = createSessionButtons(session);

            // Send the session message
            const sessionMessage = await interaction.channel.send({ embeds: [embed], components: components });

            // Update session with message ID
            db.run(`UPDATE sessions SET message_id = ? WHERE id = ?`, [sessionMessage.id, sessionId]);

            // Clear temp data
            if (client.tempData?.[userId]) {
                delete client.tempData[userId];
            }

            await interaction.update({
                content: `Session created successfully! ID: ${sessionId}`,
                components: []
            });
        });
}

// Button click handlers
async function handleQuickJoin(interaction, sessionId, role) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    // Get user's accounts that have a rank for this role
    const rankColumn = `${role.toLowerCase()}_rank`;
    const divisionColumn = `${role.toLowerCase()}_division`;

    db.all(`SELECT * FROM user_accounts WHERE discord_id = ? AND ${rankColumn} IS NOT NULL ORDER BY is_primary DESC`,
        [userId], async (err, accounts) => {
            if (!accounts || accounts.length === 0) {
                await interaction.editReply('You need to add an account and set ranks first!');
                return;
            }

            if (accounts.length === 1) {
                // Auto-select if only one account
                await processQuickJoin(interaction, sessionId, role, accounts[0].id);
            } else {
                // Show account selection
                const accountSelect = new StringSelectMenuBuilder()
                    .setCustomId(`select_account_quick_${sessionId}_${role}`)
                    .setPlaceholder('Select account')
                    .addOptions(accounts.map(acc => ({
                        label: `${acc.account_name} - ${formatRank(acc[rankColumn], acc[divisionColumn])}`,
                        value: acc.id.toString(),
                        default: acc.is_primary
                    })));

                const row = new ActionRowBuilder().addComponents(accountSelect);

                await interaction.editReply({
                    content: `Select which account to use for ${role}:`,
                    components: [row]
                });
            }
        });
}

async function processQuickJoin(interaction, sessionId, role, accountId) {
    const userId = interaction.user.id;

    // Check if already in queue or team
    db.get(`SELECT * FROM session_queue WHERE session_id = ? AND user_id = ?`,
        [sessionId, userId], (err, inQueue) => {
            if (inQueue) {
                interaction.editReply('You are already in the queue for this session!');
                return;
            }

            db.get(`SELECT * FROM session_participants WHERE session_id = ? AND user_id = ?`,
                [sessionId, userId], (err, inTeam) => {
                    if (inTeam) {
                        interaction.editReply('You are already in the team for this session!');
                        return;
                    }

                    // Add to queue
                    db.run(`INSERT INTO session_queue (session_id, user_id, account_id, preferred_roles) 
                            VALUES (?, ?, ?, ?)`,
                        [sessionId, userId, accountId, JSON.stringify([role])], async (err) => {
                            if (err) {
                                await interaction.editReply('Error joining queue.');
                                return;
                            }

                            await interaction.editReply(`Successfully joined the queue as ${role}!`);
                            await updateSessionMessage(sessionId);
                        });
                });
        });
}

async function handleToggleStreaming(interaction, sessionId) {
    const userId = interaction.user.id;

    // Check if user is in queue or team
    db.get(`SELECT * FROM session_queue WHERE session_id = ? AND user_id = ?`,
        [sessionId, userId], (err, queueEntry) => {
            if (queueEntry) {
                const newStatus = !queueEntry.is_streaming;
                db.run(`UPDATE session_queue SET is_streaming = ? WHERE id = ?`,
                    [newStatus, queueEntry.id], async (err) => {
                        await interaction.reply({
                            content: `Streaming status updated: ${newStatus ? '📺 ON' : 'OFF'}`,
                            ephemeral: true
                        });
                        await updateSessionMessage(sessionId);
                    });
            } else {
                db.get(`SELECT * FROM session_participants WHERE session_id = ? AND user_id = ?`,
                    [sessionId, userId], (err, participant) => {
                        if (participant) {
                            const newStatus = !participant.is_streaming;
                            db.run(`UPDATE session_participants SET is_streaming = ? WHERE id = ?`,
                                [newStatus, participant.id], async (err) => {
                                    await interaction.reply({
                                        content: `Streaming status updated: ${newStatus ? '📺 ON' : 'OFF'}`,
                                        ephemeral: true
                                    });
                                    await updateSessionMessage(sessionId);
                                });
                        } else {
                            interaction.reply({
                                content: 'You need to join the session first!',
                                ephemeral: true
                            });
                        }
                    });
            }
        });
}

async function handleRefreshSession(interaction, sessionId) {
    await interaction.deferReply({ ephemeral: true });

    db.get(`SELECT * FROM sessions WHERE id = ?`, [sessionId], async (err, session) => {
        if (!session) {
            await interaction.editReply('Session not found.');
            return;
        }

        // Get queue and participants
        const queueCount = await new Promise((resolve) => {
            db.get(`SELECT COUNT(*) as count FROM session_queue WHERE session_id = ?`, [sessionId], (err, result) => {
                resolve(result ? result.count : 0);
            });
        });

        const participants = await new Promise((resolve) => {
            db.all(`SELECT sp.*, ua.account_name, ua.tank_rank, ua.tank_division, ua.dps_rank, ua.dps_division, ua.support_rank, ua.support_division 
                    FROM session_participants sp 
                    LEFT JOIN user_accounts ua ON sp.account_id = ua.id 
                    WHERE sp.session_id = ?`, [sessionId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const embed = await createSessionEmbed(session, queueCount, participants);
        await interaction.editReply({ embeds: [embed] });
    });
}

// Additional button handlers for rank setting
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    if (customId.startsWith('set_rank_')) {
        const [, , accountId, role] = customId.split('_');

        // Create rank selection menu
        const rankSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_rank_${accountId}_${role}`)
            .setPlaceholder(`Select ${role} rank`)
            .addOptions(
                Object.keys(RANKS).map(rank => ({
                    label: rank,
                    value: rank
                }))
            );

        const row = new ActionRowBuilder().addComponents(rankSelect);

        await interaction.reply({
            content: `Select your ${role} rank:`,
            components: [row],
            ephemeral: true
        });
    }
});

async function handleRankSelection(interaction) {
    const [, , accountId, role] = interaction.customId.split('_');
    const selectedRank = interaction.values[0];

    // Create division selection menu
    const divisions = RANKS[selectedRank].divisions;
    const divisionSelect = new StringSelectMenuBuilder()
        .setCustomId(`select_division_${accountId}_${role}_${selectedRank}`)
        .setPlaceholder('Select division')
        .addOptions(
            divisions.map(div => ({
                label: `${selectedRank} ${div}`,
                value: div.toString()
            }))
        );

    const row = new ActionRowBuilder().addComponents(divisionSelect);

    await interaction.update({
        content: `Select your ${role} division:`,
        components: [row]
    });
}

async function handleDivisionSelection(interaction) {
    const [, , accountId, role, rank] = interaction.customId.split('_');
    const division = parseInt(interaction.values[0]);

    const rankColumn = `${role.toLowerCase()}_rank`;
    const divisionColumn = `${role.toLowerCase()}_division`;

    db.run(`UPDATE user_accounts SET ${rankColumn} = ?, ${divisionColumn} = ? WHERE id = ?`,
        [rank, division, accountId], async (err) => {
            if (err) {
                await interaction.update({ content: 'Error updating rank.', components: [] });
                return;
            }

            await interaction.update({
                content: `${role} rank updated to ${rank} ${division}!`,
                components: []
            });
        });
}

// Initialize bot
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    initializeDatabase();
    registerCommands();
});

// Login
client.login(process.env.BOT_TOKEN);