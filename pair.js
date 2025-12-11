const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require('yt-search'); // dy_scrap වෙනුවට මෙය භාවිතා කරමු
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
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
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// --- HELPER FUNCTIONS ---

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
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
        console.error(`Failed to clean duplicate files for ${number}:`, error);
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
            await delay(2000);
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const caption = formatMessage('👻 ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 👻', `📞 Number: ${number}\n Status: Connected`, 'ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥');
    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, { image: { url: config.RCD_IMAGE_PATH }, caption });
        } catch (error) {}
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage('🔐 OTP VERIFICATION', `Your OTP: *${otp}*`, 'Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 🔥');
    await socket.sendMessage(userJid, { text: message });
}

function setupNewsletterHandlers(socket) {
    // Keep your existing newsletter logic
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }
            if (config.AUTO_VIEW_STATUS === 'true') {
                await socket.readMessages([message.key]);
            }
            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        // Keep your existing delete logic
    });
}

// --- MAIN COMMAND HANDLER ---

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!type) return;

        const m = sms(socket, msg);
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

        // Ensure socket has download function
        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
             // Keep your existing download logic
        }

        if (!command) return;

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
                        buttons: [
                            { buttonId: `${prefix}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                            { buttonId: `${prefix}owner`, buttonText: { displayText: '👨‍🔧 OWNER' }, type: 1 }
                        ],
                        headerType: 4
                    }, { quoted: msg });
                    break;
                }

                // =============================================
                // ✅ FIXED MENU COMMANDS
                // =============================================

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
🔧 Built With: Node.js + JavaScript

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
                                            buttonParamsJson: JSON.stringify({ display_text: "ᴀʟɪᴠᴇ 🌿", id: `${prefix}alive` })
                                        },
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({ display_text: "🧿 • ʙᴏᴛ ᴏᴡɴᴇʀ •", id: `${prefix}owner` })
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
                        console.log(e);
                        await socket.sendMessage(from, { text: "❌ Failed to load menu." }, { quoted: msg });
                    }
                    break;
                }

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
                                            buttonParamsJson: JSON.stringify({ display_text: "⬅️ Back to Main", id: `${prefix}menu` })
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

                case 'ownermenu': {
                    const ownerMenuText = `
✨👑 QUEEN ASHA MINI BOT 👑✨
            🔥 OWNER MENU 🔥

🤖  .alive       → Check if bot is online
📋  .menu        → Show full command menu
🏓  .ping        → Check bot latency
💻  .system      → System information
⚙️  .setting     → Bot settings
🎵  .csong       → Channel song Send
📢  .jid         → Jid Check
🎴  .owner       → Bot Owners 

💌 Powered by Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸`;
                    try {
                        await socket.sendMessage(from, {
                            interactiveMessage: {
                                header: {
                                    title: "👑 OWNER ZONE",
                                    hasMediaAttachment: true,
                                    imageMessage: (await socket.prepareMessageMedia({ url: "https://i.ibb.co/TxSd6pSP/dt.png" }, "imageMessage")).imageMessage
                                },
                                body: { text: ownerMenuText },
                                footer: { text: "DILEEPA TECH MINI BOT" },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({ display_text: "⬅️ Back to Main", id: `${prefix}menu` })
                                        }
                                    ]
                                }
                            }
                        }, { quoted: msg });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(from, { text: "❌ Error showing owner menu" }, { quoted: msg });
                    }
                    break;
                }

                // =============================================
                // ✅ FIXED SONG / VIDEO COMMANDS (NEW API)
                // =============================================

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

                case 'yt_mp3': {
                    const type = args[0];
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
                    const type = args[0];
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

                // =============================================
                // ✅ OTHER RESTORED COMMANDS
                // =============================================

                case 'system': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    const captionText = `
║▻ Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ʙᴏᴛ ꜱʏꜱᴛᴇᴍ 👸◅║
╭────◅●❤️●▻────➣
💝 ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💝 ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💝 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💝 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Render⚡
╰────◅●❤️●▻────➢`;
                    await socket.sendMessage(from, { image: { url: "https://files.catbox.moe/j8003b.jpg" }, caption: captionText, headerType: 1 }, { quoted: msg });
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    const loading = await socket.sendMessage(from, { text: "*𝗧𝗘𝗦𝗧𝗜𝗡𝗚 𝗧𝗛𝗘 𝗕𝗢𝗧*" }, { quoted: msg });
                    const end = Date.now();
                    await socket.sendMessage(from, { text: `🦹‍♀️ 𝘗𝘐𝘕𝘎 ▻ \`${end - start}ms\`\n\n ʙᴏᴛ ɪꜱ ᴀᴄᴛɪᴠᴇ ᴛᴏ ꜱɪɢɴᴀʟ 💝👻⚡`, edit: loading.key });
                    break;
                }

                case 'owner': {
                    const ownerNumber = config.OWNER_NUMBER;
                    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Kavindu & Ishan\nTEL;type=CELL;type=VOICE;waid=' + ownerNumber + ':' + ownerNumber + '\nEND:VCARD';
                    await socket.sendMessage(from, { contacts: { displayName: 'Owner', contacts: [{ vcard }] } });
                    break;
                }

                case 'fancy': {
                    const text = body.replace(/^.fancy\s+/i, "");
                    if (!text) return await socket.sendMessage(from, { text: "❎ *Please provide text.*" });
                    try {
                        const response = await axios.get(`https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`);
                        if (!response.data.status) return await socket.sendMessage(from, { text: "❌ Error fetching fonts." });
                        const fontList = response.data.result.map(font => `*${font.name}:*\n${font.result}`).join("\n\n");
                        await socket.sendMessage(from, { text: `🎨 Fancy Fonts\n\n${fontList}` }, { quoted: msg });
                    } catch (e) {
                        await socket.sendMessage(from, { text: "⚠️ Error occurred." });
                    }
                    break;
                }

                case 'fb': {
                    const getFBInfo = require('@xaviabot/fb-downloader');
                    if (!args[0] || !args[0].startsWith('http')) return await socket.sendMessage(from, { text: '❎ *Please provide a valid Facebook video link.*' }, { quoted: msg });
                    try {
                        await socket.sendMessage(from, { react: { text: "⏳", key: msg.key } });
                        const fb = await getFBInfo(args[0]);
                        const caption = `🎬💚 *FB DOWNLOADER*\n\n💚 *Title:* ${fb.title}\n`;
                        await socket.sendMessage(from, {
                            image: { url: fb.thumbnail },
                            caption: caption,
                            buttons: [
                                { buttonId: `.fbsd ${args[0]}`, buttonText: { displayText: '💚 ꜱᴅ ᴠɪᴅᴇᴏ' }, type: 1 },
                                { buttonId: `.fbhd ${args[0]}`, buttonText: { displayText: '💚 ʜᴅ ᴠɪᴅᴇᴏ' }, type: 1 }
                            ],
                            headerType: 4
                        }, { quoted: msg });
                    } catch (e) {
                        await socket.sendMessage(from, { text: '❌ Error processing FB link.' });
                    }
                    break;
                }

                case 'fbsd': {
                    const getFBInfo = require('@xaviabot/fb-downloader');
                    try {
                        const res = await getFBInfo(args[0]);
                        await socket.sendMessage(from, { video: { url: res.sd }, caption: '✅ SD Video' }, { quoted: msg });
                    } catch (e) { await socket.sendMessage(from, { text: '❌ Failed.' }); }
                    break;
                }
                case 'fbhd': {
                    const getFBInfo = require('@xaviabot/fb-downloader');
                    try {
                        const res = await getFBInfo(args[0]);
                        await socket.sendMessage(from, { video: { url: res.hd }, caption: '✅ HD Video' }, { quoted: msg });
                    } catch (e) { await socket.sendMessage(from, { text: '❌ Failed.' }); }
                    break;
                }

                case 'ai':
                case 'gpt': {
                    if (!args[0]) return await socket.sendMessage(from, { text: '*🚫 Provide a message.*' });
                    await socket.sendMessage(from, { react: { text: '🤖', key: msg.key } });
                    const prompt = `Act as Dileepa-Tech Mini bot. User says: ${args.join(" ")}`;
                    try {
                        const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSyDD79CzhemWoS4WXoMTpZcs8g0fWNytNug`, { contents: [{ parts: [{ text: prompt }] }] });
                        const aiReply = data.candidates[0].content.parts[0].text;
                        await socket.sendMessage(from, { text: aiReply, footer: '🤖 DILEEPA-TECH AI' });
                    } catch (e) { await socket.sendMessage(from, { text: '*❌ AI Error.*' }); }
                    break;
                }

                case 'active': {
                    const count = activeSockets.size;
                    let message = `*⚡ ACTIVE BOTS: ${count}*\n`;
                    Array.from(activeSockets.keys()).forEach((num, i) => {
                         message += `*${i + 1}.* +${num}\n`;
                    });
                    await socket.sendMessage(from, { text: message });
                    break;
                }

                 case 'tiktok': {
                    try {
                        if(!args[0]) return await socket.sendMessage(from, {text: "Link needed"});
                        const apiUrl =`https://saviya-kolla-api.koyeb.app/download/tiktok?url=${encodeURIComponent(args[0])}`;
                        const { data } = await axios.get(apiUrl);
                        if (!data.status) return await socket.sendMessage(from, {text: "Error"});
                        await socket.sendMessage(from, { video: { url: data.data.meta.media.find(v => v.type === "video").org }, caption: "TikTok Video" });
                    } catch(e) { console.log(e); }
                    break;
                }

                case 'jid': {
                    await socket.sendMessage(from, { text: `*🆔 JID:* ${from}` });
                    break;
                }
                
                case 'set': 
                case 'settings': {
                    // Settings logic can be kept simple for now or copied fully if needed
                    await socket.sendMessage(from, { text: "Settings command placeholder" });
                    break;
                }

            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(from, { text: '❌ ERROR: ' + error.message }, { quoted: msg });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (config.AUTO_RECORDING === 'true') {
            await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
        }
    });
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection } = update;
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

        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupStatusHandlers(socket);
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

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    if (activeSockets.has(number)) return res.send({ status: 'connected' });
    await EmpirePair(number, res);
});

module.exports = router;
