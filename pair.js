const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const yts = require('yt-search'); // Added yt-search
const { sms } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage
} = require('baileys');

const FIREBASE_URL = 'https://kavindu34compl-default-rtdb.firebaseio.com/';

const config = {
    THARUZZ_FOOTER: '> Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ',
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['😒', '🍬', '💝', '💗', '🎈', '🎉', '🥳', '❤️', '💕', '👨‍🔧'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/EkmRlbdIPHD8V7qordJyH3',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/j8003b.jpg',
    NEWSLETTER_JID: '120363421312638293@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94770051298',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6FwIK89inhtCZOlp12'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// --- Helper Functions ---

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        );

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
    
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            return { status: 'success', gid: response };
        } catch (error) {
            retries--;
            if (retries === 0) return { status: 'failed', error: error.message };
            await delay(2000);
        }
    }
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const caption = formatMessage(
        '👻 ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 👻',
        `📞 Number: ${number}\n Status: Connected`,
        'ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, {
                image: { url: config.RCD_IMAGE_PATH },
                caption
            });
        } catch (error) {}
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage('🔐 OTP VERIFICATION', `OTP: *${otp}*`, 'Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 🔥');
    await socket.sendMessage(userJid, { text: message });
}

// --- Main Command Handler ---

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!type) return;

        const m = sms(socket, msg); // Assumes sms function wraps the message correctly
        const body = (type === 'conversation') ? msg.message.conversation :
            (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text :
            (type == 'interactiveResponseMessage') ? JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id :
            (type == 'templateButtonReplyMessage') ? msg.message.templateButtonReplyMessage.selectedId :
            (type == 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage.selectedButtonId :
            (type == 'listResponseMessage') ? msg.message.listResponseMessage.singleSelectReply.selectedRowId :
            (type == 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption : 
            (type == 'videoMessage' && msg.message.videoMessage.caption) ? msg.message.videoMessage.caption : '';

        const sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const prefix = config.PREFIX;
        const isCmd = body.startsWith(prefix);
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
        const args = body.trim().split(/ +/).slice(1);
        const from = msg.key.remoteJid;

        if (!isCmd) return;

        try {
            switch (command) {

                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const aliveText = `
❲ Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ʙᴏᴛ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ 🔥 ❳

╭────◅●💗●▻────➣
💝 ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💝 ʙᴏᴛ ᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💝 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
╰────◅●💗●▻────➢

> Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ʙᴏᴛ 🔥`;

                    await socket.sendMessage(from, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: aliveText,
                        footer: config.THARUZZ_FOOTER,
                        buttons: [
                            { buttonId: `${prefix}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                            { buttonId: `${prefix}owner`, buttonText: { displayText: '👨‍🔧 OWNER' }, type: 1 }
                        ],
                        headerType: 4
                    }, { quoted: msg });
                    break;
                }

                // --- FIXED MENU ---
                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const menuText = `
❲ 👑 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ Bᴏᴛ 🔥 ❳

║▻ 𝙏𝙝𝙞𝙨 𝙞𝙨 𝙢𝙮 𝙢𝙚𝙣𝙪 𝙡𝙞𝙨𝙩 ◅║

╭────◅●👾●▻────➣
💝 ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s
💝 ʙᴏᴛ ᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size}
💝 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ
💝 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳
💝 ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ Kavindu & Ishan
╰────◅●👾●▻────➢

🛡️ A New Era of WhatsApp Bot Automation

> Owner: Kavindu & Ishan 💥

🔧 Built With:
Node.js + JavaScript
Auto deploy and free ❕

> 👑 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ Bᴏᴛ 🔥`;

                    try {
                        await socket.sendMessage(from, {
                            interactiveMessage: {
                                header: {
                                    title: "👑 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ Bᴏᴛ",
                                    hasMediaAttachment: true,
                                    imageMessage: (await socket.prepareMessageMedia({ url: "https://files.catbox.moe/j8003b.jpg" }, "imageMessage")).imageMessage
                                },
                                body: { text: menuText },
                                footer: { text: "Powered by Queen Asha Mini Bot" },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "ᴀʟɪᴠᴇ 🌿",
                                                id: `${prefix}alive`
                                            })
                                        },
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "🧿 • ʙᴏᴛ ᴏᴡɴᴇʀ •",
                                                id: `${prefix}owner`
                                            })
                                        },
                                        {
                                            name: "single_select",
                                            buttonParamsJson: JSON.stringify({
                                                title: " ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻",
                                                sections: [{
                                                    title: "Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸",
                                                    rows: [
                                                        { title: "💾 Download Commands", description: "Get Song, Video, FB & TikTok downloader", id: `${prefix}dmenu` },
                                                        { title: "👑 Owner Commands", description: "System and Owner configurations", id: `${prefix}ownermenu` }
                                                    ]
                                                }]
                                            })
                                        }
                                    ]
                                }
                            }
                        }, { quoted: msg });
                    } catch (e) {
                        console.error("Menu Error:", e);
                        await socket.sendMessage(from, { text: "❌ Failed to load menu." }, { quoted: msg });
                    }
                    break;
                }

                // --- FIXED DMENU ---
                case 'dmenu': {
                    const dmenuText = `
✨🌺  QUEEN ASHA MINI BOT 🌺✨
          🔥 DOWNLOAD MENU 🔥

💿  • .song      | Download Your Favorite Tunes
🌐  • .fb        | Save Facebook Videos Easily
🎥  • .tiktok    | Grab TikTok Clips Instantly

─────────────
💌 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸`;

                    try {
                        await socket.sendMessage(from, {
                            interactiveMessage: {
                                header: {
                                    title: "🔥 DOWNLOAD ZONE",
                                    hasMediaAttachment: true,
                                    imageMessage: (await socket.prepareMessageMedia({ url: "https://files.catbox.moe/j8003b.jpg" }, "imageMessage")).imageMessage
                                },
                                body: { text: dmenuText },
                                footer: { text: "Queen Asha Mini Bot" },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "⬅️ Back to Main",
                                                id: `${prefix}menu`
                                            })
                                        }
                                    ]
                                }
                            }
                        }, { quoted: msg });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(from, { text: "❌ Error showing download menu" }, { quoted: msg });
                    }
                    break;
                }

                case 'owner': {
                    const ownerNumber = config.OWNER_NUMBER;
                    const vcard = 'BEGIN:VCARD\n' +
                                  'VERSION:3.0\n' +
                                  `FN:Kavindu & Ishan\n` +
                                  `ORG:QUEEN-ASHA MINI;\n` +
                                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:${ownerNumber}\n` +
                                  'END:VCARD';
                    await socket.sendMessage(from, {
                        contacts: { displayName: 'Kavindu & Ishan', contacts: [{ vcard }] }
                    });
                    break;
                }

                // --- SONG COMMAND (API INTEGRATED) ---
                case 'song': {
                    const q = args.join(" ");
                    if (!q) return await socket.sendMessage(from, { text: '❌ Please enter a song name or URL!' }, { quoted: msg });

                    await socket.sendMessage(from, { react: { text: '🎧', key: msg.key } });

                    try {
                        const search = await yts(q);
                        const data = search.videos[0];
                        if (!data) return await socket.sendMessage(from, { text: '❌ Song not found!' }, { quoted: msg });

                        const caption = `*🎧 THARUSHA-MD SONG DOWNLOADER*\n\n` +
                                        `*📌 Title:* ${data.title}\n` +
                                        `*⏰ Duration:* ${data.timestamp}\n` +
                                        `*📅 Released:* ${data.ago}\n` +
                                        `*👀 Views:* ${data.views}\n` +
                                        `*📎 URL:* ${data.url}\n\n` +
                                        config.THARUZZ_FOOTER;

                        const buttons = [
                            { buttonId: `${prefix}yt_mp3 AUDIO ${data.url}`, buttonText: { displayText: '🎵 AUDIO' }, type: 1 },
                            { buttonId: `${prefix}yt_mp3 DOCUMENT ${data.url}`, buttonText: { displayText: '📂 DOCUMENT' }, type: 1 }
                        ];

                        await socket.sendMessage(from, {
                            image: { url: data.thumbnail },
                            caption: caption,
                            buttons: buttons,
                            headerType: 1
                        }, { quoted: msg });

                    } catch (e) {
                        console.error(e);
                        await socket.sendMessage(from, { text: '❌ Error fetching song details.' }, { quoted: msg });
                    }
                    break;
                }

                // --- VIDEO COMMAND (API INTEGRATED) ---
                case 'video': {
                    const q = args.join(" ");
                    if (!q) return await socket.sendMessage(from, { text: '❌ Please enter a video name or URL!' }, { quoted: msg });

                    await socket.sendMessage(from, { react: { text: '📽️', key: msg.key } });

                    try {
                        const search = await yts(q);
                        const data = search.videos[0];
                        if (!data) return await socket.sendMessage(from, { text: '❌ Video not found!' }, { quoted: msg });

                        const caption = `*📽️ THARUSHA-MD VIDEO DOWNLOADER*\n\n` +
                                        `*📌 Title:* ${data.title}\n` +
                                        `*⏰ Duration:* ${data.timestamp}\n` +
                                        `*📅 Released:* ${data.ago}\n` +
                                        `*👀 Views:* ${data.views}\n` +
                                        `*📎 URL:* ${data.url}\n\n` +
                                        config.THARUZZ_FOOTER;

                        const buttons = [
                            { buttonId: `${prefix}yt_mp4 VIDEO ${data.url}`, buttonText: { displayText: '🎬 VIDEO' }, type: 1 },
                            { buttonId: `${prefix}yt_mp4 DOCUMENT ${data.url}`, buttonText: { displayText: '📂 DOCUMENT' }, type: 1 }
                        ];

                        await socket.sendMessage(from, {
                            image: { url: data.thumbnail },
                            caption: caption,
                            buttons: buttons,
                            headerType: 1
                        }, { quoted: msg });

                    } catch (e) {
                        console.error(e);
                        await socket.sendMessage(from, { text: '❌ Error fetching video details.' }, { quoted: msg });
                    }
                    break;
                }

                // --- DOWNLOADERS (USING API) ---
                case 'yt_mp3': {
                    const type = args[0]; // AUDIO or DOCUMENT
                    const url = args[1];
                    if (!url) return;

                    await socket.sendMessage(from, { react: { text: '⬇️', key: msg.key } });

                    try {
                        const apiUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/download/ytmp3?url=${url}&quality=128`;
                        const res = await axios.get(apiUrl);
                        const dlUrl = res.data.result?.download?.url;
                        const title = res.data.result?.title || 'Song';

                        if (!dlUrl) return await socket.sendMessage(from, { text: '❌ API Error.' }, { quoted: msg });

                        if (type === 'AUDIO') {
                            await socket.sendMessage(from, { audio: { url: dlUrl }, mimetype: 'audio/mpeg' }, { quoted: msg });
                        } else if (type === 'DOCUMENT') {
                            await socket.sendMessage(from, { document: { url: dlUrl }, mimetype: 'audio/mpeg', fileName: `${title}.mp3`, caption: config.THARUZZ_FOOTER }, { quoted: msg });
                        }

                    } catch (e) {
                        console.error(e);
                        await socket.sendMessage(from, { text: '❌ Download failed.' }, { quoted: msg });
                    }
                    break;
                }

                case 'yt_mp4': {
                    const type = args[0]; // VIDEO or DOCUMENT
                    const url = args[1];
                    if (!url) return;

                    await socket.sendMessage(from, { react: { text: '⬇️', key: msg.key } });

                    try {
                        const apiUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/download/ytmp4?url=${url}&quality=360`;
                        const res = await axios.get(apiUrl);
                        const dlUrl = res.data.result?.download?.url;
                        const title = res.data.result?.title || 'Video';

                        if (!dlUrl) return await socket.sendMessage(from, { text: '❌ API Error.' }, { quoted: msg });

                        if (type === 'VIDEO') {
                            await socket.sendMessage(from, { video: { url: dlUrl }, caption: `${title}\n${config.THARUZZ_FOOTER}` }, { quoted: msg });
                        } else if (type === 'DOCUMENT') {
                            await socket.sendMessage(from, { document: { url: dlUrl }, mimetype: 'video/mp4', fileName: `${title}.mp4`, caption: config.THARUZZ_FOOTER }, { quoted: msg });
                        }

                    } catch (e) {
                        console.error(e);
                        await socket.sendMessage(from, { text: '❌ Download failed.' }, { quoted: msg });
                    }
                    break;
                }
                
                // Add other commands here (fb, tiktok, etc. if needed)

            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(from, { text: '❌ ERROR: ' + error.message }, { quoted: msg });
        }
    });
}

// --- Setup & Connection Logic ---

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (config.AUTO_RECORDING === 'true') {
            await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
        }
    });
}

function setupNewsletterHandlers(socket) {
    // Optional: Add newsletter logic here
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            console.log(`Connection closed for ${number}, reconnecting...`);
            await delay(5000);
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        } else if (connection === 'open') {
            console.log(`Opened connection for ${number}`);
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    // Normally load from Firebase here, skipped for brevity in this snippet
    // Assuming local file usage or you can add the restoreSession function back

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Attach Handlers
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        
        socket.ev.on('creds.update', saveCreds);

        if (!socket.authState.creds.registered) {
            await delay(1500);
            try {
                const code = await socket.requestPairingCode(sanitizedNumber);
                if (!res.headersSent) res.send({ code });
            } catch (e) {
                console.error('Pairing code error:', e);
            }
        }

        activeSockets.set(sanitizedNumber, socket);

    } catch (error) {
        console.error('Pairing error:', error);
    }
}

// --- Express Routes ---

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    if (activeSockets.has(number)) return res.send({ status: 'connected' });
    await EmpirePair(number, res);
});

module.exports = router;
