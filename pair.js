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
    NEWSLETTER_JID: ' 120363421312638293@newsletter',
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
    // Remove GitHub, now using Firebase
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Load session data from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
                console.log(`Deleted duplicate session file: ${sessionKeys[i]}`);
            }
        }

        // Check config file existence
        const configKey = `config_${sanitizedNumber}.json`;
        if (data[configKey]) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '👻 ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ  👻',
        `📞 Number: ${number}\n Status: Connected`,
        '> > ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}
async function updateStoryStatus(socket) {
    const statusMessage = `DILEEPA TECH MINI BOT CONNECTION SUCSESS..! 🚀`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}
async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '> > Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 🔥'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'ＧIᗰ𝛥𝛥 ᗰD ᗰini 𝐁𝙾𝚃'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socke.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }

}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

const type = getContentType(msg.message);
    if (!msg.message) return	
  msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
	const m = sms(socket, msg);
	const quoted =
        type == "extendedTextMessage" &&
        msg.message.extendedTextMessage.contextInfo != null
          ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
          : []
        const body = (type === 'conversation') ? msg.message.conversation 
    : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'interactiveResponseMessage') 
        ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
            && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
    : (type == 'templateButtonReplyMessage') 
        ? msg.message.templateButtonReplyMessage?.selectedId 
    : (type === 'extendedTextMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'imageMessage') && msg.message.imageMessage.caption 
        ? msg.message.imageMessage.caption 
    : (type == 'videoMessage') && msg.message.videoMessage.caption 
        ? msg.message.videoMessage.caption 
    : (type == 'buttonsResponseMessage') 
        ? msg.message.buttonsResponseMessage?.selectedButtonId 
    : (type == 'listResponseMessage') 
        ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
    : (type == 'messageContextInfo') 
        ? (msg.message.buttonsResponseMessage?.selectedButtonId 
            || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            || msg.text) 
    : (type === 'viewOnceMessage') 
        ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
    : (type === "viewOnceMessageV2") 
        ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
    : '';
	 	let sender = msg.key.remoteJid;
	  const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
          const senderNumber = nowsender.split('@')[0]
          const developers = `${config.OWNER_NUMBER}`;
          const botNumber = socket.user.id.split(':')[0]
          const isbot = botNumber.includes(senderNumber)
          const isOwner = isbot ? isbot : developers.includes(senderNumber)
          var prefix = config.PREFIX
	  var isCmd = body.startsWith(prefix)
    	  const from = msg.key.remoteJid;
          const isGroup = from.endsWith("@g.us")
	      const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
          var args = body.trim().split(/ +/).slice(1)
socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
                let quoted = message.msg ? message.msg : message
                let mime = (message.msg || message).mimetype || ''
                let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
                const stream = await downloadContentFromMessage(quoted, messageType)
                let buffer = Buffer.from([])
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk])
                }
                let type = await FileType.fromBuffer(buffer)
                trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
                await fs.writeFileSync(trueFileName, buffer)
                return trueFileName
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

    const captionText = `
❲ Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ʙᴏᴛ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ 🔥 ❳

║▻ 𝙄 𝙖𝙢 𝙤𝙣𝙡𝙞𝙣𝙚 𝙣𝙤𝙬 👑🔥 ◅║

╭────◅●💗●▻────➣
💝  ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💝  ʙᴏᴛ ᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💝  ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💝  ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳ ⚡
💝  ʙᴏᴛ ᴅᴇᴠᴇʟᴏᴘᴇʀꜱ ➟ Ishan & Kavindu ⚡
╰────◅●💗●▻────➢

*➟

◅𝙃𝙖𝙫𝙚 𝙖 𝙣𝙞𝙘𝙚 𝙙𝙖𝙮.. 👑❤️▻
*

> Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ʙᴏᴛ 🔥

`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '❲ 𝘔𝘌𝘕𝘜 👻 ❳' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: ' ❲ 𝘖𝘞𝘕𝘌𝘙 👻 ❳' },
            type: 1,
        }, 
                    {
            buttonId: 'action',
            buttonText: {
                displayText: ' ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 🔥`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🍁 M E N U 🍁',
                                    description: 'Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '🧿 • ʙᴏᴛ ᴏᴡɴᴇʀ •',
                                    description: 'Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸',
                                    id: `${config.PREFIX}owner`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://files.catbox.moe/j8003b.jpg" },
        caption: `Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸\n\n${captionText}`,
    }, { quoted: msg });

    break;
}

//---------------------------------------setting--------------------------------------//
case 'settings':
case 'setting': {
    const adminNumbers = [
        '94770051298', // bot owner
        // '94764040298, // admin
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: msg });
    }

    // Load user config (or default)
    const userConfig = await loadUserConfig(sanitizedNumber);

    // Only show these keys, in this order:
    const keys = [
		'PREFIX',
        'AUTO_VIEW_STATUS',
        'AUTO_LIKE_STATUS',
        'AUTO_RECORDING',
        
    ];

    // Emoji map for each setting
    const emojiMap = {
		PREFIX: '🔑',
        AUTO_VIEW_STATUS: '👀',
        AUTO_LIKE_STATUS: '❤️',
        AUTO_RECORDING: '🎙️',
        AUTO_LIKE_EMOJI: '😻'
        
    };

    // Helper to format ON/OFF
    const onOff = v => v === true || v === 'true' ? '🟢 ON' : '🔴 OFF';

    // Build the settings text
    let settingsText = `╭━━━[ *🛠️ Your Settings* ]━━━⬣\n`;

    for (const key of keys) {
        let value = userConfig[key];
        if (key === 'AUTO_LIKE_EMOJI' && Array.isArray(value)) {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value.join(' ')}\n`;
        } else if (typeof value === 'boolean' || value === 'true' || value === 'false') {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${onOff(value)}\n`;
        } else {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value}\n`;
        }
    }

    settingsText += `╰━━━━━━━━━━━━━━━━━━⬣\n`;
	settingsText += `Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true\n`;
	settingsText += `> *⚡ ᴘᴏᴡᴇʀᴇᴅ ʙʏ 👑 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ ⚡*`;

    await socket.sendMessage(m.chat, { react: { text: '⚙️', key: msg.key } });
    await socket.sendMessage(sender, { text: settingsText }, { quoted: msg });
    break;
}
case 'set': {
    // Only allow the bot number to edit configs
    const adminNumbers = [
      '94770051298', // bot owner
      //'94764040298, // admin
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: msg });
    }
    if (args.length < 2) {
        return await socket.sendMessage(sender, { text: 'Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true' }, { quoted: msg });
    }
    const key = args[0].toUpperCase();
    let value = args.slice(1).join(' ');

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(value)) value = Number(value);

    let userConfig = await loadUserConfig(sanitizedNumber);

    if (!(key in defaultUserConfig)) {
        return await socket.sendMessage(sender, { text: `Unknown setting: ${key}` }, { quoted: msg });
    }

    userConfig[key] = value;
    await updateUserConfig(sanitizedNumber, userConfig);
 await socket.sendMessage(m.chat, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: `✅ Setting *${key}* updated to *${value}*.` }, { quoted: msg });
    break;
}

             case 'menu': {
    const bot = socket || conn || client; 
    const p = config.PREFIX || '.'; 

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
        await bot.sendMessage(from, {
            interactiveMessage: {
                title: "👑 Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ Bᴏᴛ",
                body: { text: menuText },
                footer: { text: "Powered by Queen Asha Mini Bot" },
                thumbnail: "https://files.catbox.moe/j8003b.jpg", // ඔබගේ pakaya කේස් එකේ තිබු ක්‍රමය
                nativeFlowMessage: {
                    buttons: [
                        {
                            name: "quick_reply",
                            buttonParamsJson: JSON.stringify({
                                display_text: "ᴀʟɪᴠᴇ 🌿",
                                id: `${p}alive`
                            })
                        },
                        {
                            name: "quick_reply",
                            buttonParamsJson: JSON.stringify({
                                display_text: "🧿 • ʙᴏᴛ ᴏᴡɴᴇʀ •",
                                id: `${p}owner`
                            })
                        },
                        {
                            name: "single_select",
                            buttonParamsJson: JSON.stringify({
                                title: " ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻",
                                sections: [
                                    {
                                        title: "Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸",
                                        rows: [
                                            {
                                                title: "💾 Download Commands",
                                                description: "Get Song, Video, FB & TikTok downloader",
                                                id: `${p}dmenu`
                                            },
                                            {
                                                title: "👑 Owner Commands",
                                                description: "System and Owner configurations",
                                                id: `${p}ownermenu`
                                            }
                                        ]
                                    }
                                ]
                            })
                        }
                    ]
                }
            }
        }, { quoted: msg });

    } catch (e) {
        console.log(e);
        await bot.sendMessage(from, { text: "❌ Failed to load menu." }, { quoted: msg });
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
        await sock.sendMessage(from, {
            interactiveMessage: {
                header: {
                    title: "🔥 DOWNLOAD ZONE",
                    hasMediaAttachment: true,
                    imageMessage: (await sock.prepareMessageMedia({ url: "https://files.catbox.moe/j8003b.jpg" }, "imageMessage")).imageMessage
                },
                body: {
                    text: dmenuText
                },
                footer: {
                    text: "Queen Asha Mini Bot"
                },
                nativeFlowMessage: {
                    buttons: [
                        {
                            name: "quick_reply",
                            buttonParamsJson: JSON.stringify({
                                display_text: "⬅️ Back to Main",
                                id: `${prefix}menu`
                            })
                        },
                        {
                            name: "single_select",
                            buttonParamsJson: JSON.stringify({
                                title: "📍 SELECT OPTION",
                                sections: [
                                    {
                                        title: "Shortcuts",
                                        rows: [
                                            {
                                                title: "🤖 Check Bot Status",
                                                description: "Check if bot is running perfectly",
                                                id: `${prefix}alive`
                                            },
                                            {
                                                title: "💬 Commands List",
                                                description: "View all available commands",
                                                id: `${prefix}listmenu`
                                            }
                                        ]
                                    }
                                ]
                            })
                        }
                    ]
                }
            }
        }, { quoted: msg });
    } catch (e) {
        console.log(e);
        await sock.sendMessage(from, { text: "❌ Error showing download menu" }, { quoted: msg });
    }
    break;
}
					

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
💝 ʀᴀᴍ ᴜꜱᴇɢᴇ ➟ 36220/3420 GB ⚡
💝 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Render⚡
💝 ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94770051298 ⚡
╰────◅●❤️●▻────➢
> Queen Asha Mini Bot 💚👨‍🔧`;
	
    const templateButtons = [
        {
            buttonId: `${config.PREFIX}ping`,
            buttonText: { displayText: '👻 𝙿𝙸𝙽𝙶 ' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '👻 𝙼𝙴𝙽𝚄' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: '👻 𝙾𝚆𝙽𝙴𝚁' },
            type: 1
        }
    ];

    await socket.sendMessage(m.chat, {
        image: { url: "https://files.catbox.moe/j8003b.jpg" },
        caption: captionText.trim(),
        footer: 'Qᴜᴇᴇɴ Aꜱʜᴀ Mɪɴɪ 👸',
        buttons: templateButtons,
        headerType: 1
    }, { quoted: msg });

    break;
			   }
case 'ping': {
    const os = require("os")
    const start = Date.now();

    const loading = await socket.sendMessage(m.chat, {
        text: "*𝗧𝗘𝗦𝗧𝗜𝗡𝗚 𝗧𝗛𝗘 𝗕𝗢𝗧*"
    }, { quoted: msg });

    const stages = ["*○○○○", "**○○○", "***○○", "****○", "*****"];
    for (let stage of stages) {
        await socket.sendMessage(m.chat, { text: stage, edit: loading.key });
        await new Promise(r => setTimeout(r, 250));
    }

    const end = Date.now();
    const ping = end - start;

    await socket.sendMessage(m.chat, {
        text: `🦹‍♀️ 𝘗𝘐𝘕𝘎  ▻  \`50.001ms\`\n\n ʙᴏᴛ ɪꜱ ᴀᴄᴛɪᴠᴇ ᴛᴏ ꜱɪɢɴᴀʟ 💝👻⚡`,
        edit: loading.key
    });

    break;
			}

		        case 'owner': {
    const ownerNumber = '+94770051298';
    const ownerName = 'Kavindu & Ishan';
    const organization = '*QUEEN-ASHA MINI BOT OWNER 👾*';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Then send message with reference
        await socket.sendMessage(from, {
            text: `* 💝 DILEEPA TECH MINI BOT OWNER*\n\n👨‍🔧 Name: ${ownerName}\n💭 ηυмвєя ➥ ${ownerNumber}\n\n> ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥`,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                quotedMessageId: sent.key.id
            }
        }, { quoted: msg });

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        }, { quoted: msg });
    }
				
          
        
  break;
       }
			    
case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Dila`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 Fancy Fonts Converter\n\n${fontList}\n\n_ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
	}
					case 'video': {
    await socket.sendMessage(sender, { react: { text: '📽️', key: msg.key } });

    // Function to extract YouTube ID (Same logic as your song command)
    function replaceYouTubeID(url) {
        const regex = /(?:youtube\.com\/(?:.*v=|.*\/)|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    const q = args.join(" ");
    if (!args[0]) {
        return await socket.sendMessage(from, {
            text: 'Please enter youtube video name or link !!'
        }, { quoted: msg });
    }

    try {
        let id = q.startsWith("https://") ? replaceYouTubeID(q) : null;

        // If not a link, search for the video
        if (!id) {
            const searchResults = await dy_scrap.ytsearch(q);
            if (!searchResults?.results?.length) {
                return await socket.sendMessage(from, {
                    text: '*📛 Please enter valid youtube video name or url.*'
                }, { quoted: msg });
            }
            // Use the first search result's ID logic via scraping or just proceed with link construction
            // Since dy_scrap returns results, we can just pick the first one's URL to extract ID or pass URL
            const firstResultUrl = searchResults.results[0].url;
            id = replaceYouTubeID(firstResultUrl);
        }

        if (!id) {
             return await socket.sendMessage(from, { text: '*📛 Video not found.*' }, { quoted: msg });
        }

        const videoUrl = `https://youtube.com/watch?v=${id}`;
        
        // Fetch Video Info using dy_scrap (consistent with your song command)
        const data = await dy_scrap.ytsearch(videoUrl);

        if (!data?.results?.length) {
            return await socket.sendMessage(from, {
                text: '*📛 Cannot fetch video details.*'
            }, { quoted: msg });
        }

        const { url, title, image, timestamp, ago, views, author } = data.results[0];

        const caption = `*📽️ \`THARUSHA-MD VIDEO DOWNLOADER\`*\n\n` +
            `*┏━━━━━━━━━━━━━━━*\n` +
            `*┃ 📌 \`тιтℓє:\` ${title || "No info"}*\n` +
            `*┃ ⏰ \`∂υяαтιση:\` ${timestamp || "No info"}*\n` +
            `*┃ 📅 \`яєℓєαѕє∂ ∂αтє:\` ${ago || "No info"}*\n` +
            `*┃ 👀 \`νιєωѕ:\` ${views || "No info"}*\n` +
            `*┃ 👤 \`αυтнσя:\` ${author || "No info"}*\n` +
            `*┃ 📎 \`υяℓ:\` ~${url || "No info"}~*\n` +
            `*┗━━━━━━━━━━━━━━━━━━*\n\n` + config.THARUZZ_FOOTER;

        const templateButtons = [
            {
                buttonId: `${config.PREFIX}yt_mp4 VIDEO ${url}`,
                buttonText: { displayText: '🎬 ᴅᴏᴡɴʟᴏᴀᴅ ᴠɪᴅᴇᴏ' },
                type: 1,
            },
            {
                buttonId: `${config.PREFIX}yt_mp4 DOCUMENT ${url}`,
                buttonText: { displayText: '📂 ᴅᴏᴄᴜᴍᴇɴᴛ ᴛʏᴘᴇ' },
                type: 1,
            }
        ];

        await socket.sendMessage(
            from, {
                image: { url: image },
                caption: caption,
                buttons: templateButtons,
                headerType: 1
            }, { quoted: msg }
        );

    } catch (e) {
        console.log("❌ Video command error: " + e);
        await socket.sendMessage(from, { text: '❌ Error finding video.' }, { quoted: msg });
    }

    break;
}

// Sub-command to handle the actual download using the API you requested
case 'yt_mp4': {
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    const q = args.join(" ");
    const type = q.split(" ")[0]; // VIDEO or DOCUMENT
    const videoLink = q.split(" ")[1];

    if (!videoLink) return;

    try {
        // Using the requested API
        const apiUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/download/ytmp4?url=${videoLink}&quality=360`; // Defaulting to 360p for speed
        const response = await fetch(apiUrl);
        const json = await response.json();

        // Check if API returned valid data
        if (!json.result || !json.result.download || !json.result.download.url) {
             return await socket.sendMessage(from, { text: '❌ Error fetching video from API.' }, { quoted: msg });
        }

        const downloadUrl = json.result.download.url;
        const videoTitle = json.result.title || 'Video';

        if (type === "VIDEO") {
            await socket.sendMessage(
                from, {
                    video: { url: downloadUrl },
                    caption: `*🎬 ${videoTitle}*\n\n${config.THARUZZ_FOOTER}`
                }, { quoted: msg }
            );
        }

        if (type === "DOCUMENT") {
            await socket.sendMessage(
                from, {
                    document: { url: downloadUrl },
                    mimetype: "video/mp4",
                    fileName: `${videoTitle}.mp4`,
                    caption: `*📂 Here is your video document*\n\n${config.THARUZZ_FOOTER}`
                }, { quoted: msg }
            );
        }

    } catch (e) {
        console.log("❌ yt_mp4 command error: " + e);
        await socket.sendMessage(from, { text: '❌ Error downloading video.' }, { quoted: msg });
    }

    break;
}
case 'song': {
    
    await socket.sendMessage(sender, { react: { text: '🎧', key: msg.key } });
    
    function replaceYouTubeID(url) {
    const regex = /(?:youtube\.com\/(?:.*v=|.*\/)|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}
    
    const q = args.join(" ");
    if (!args[0]) {
        return await socket.sendMessage(from, {
      text: 'Please enter you tube song name or link !!'
    }, { quoted: msg });
    }
    
    try {
        let id = q.startsWith("https://") ? replaceYouTubeID(q) : null;
        
        if (!id) {
            const searchResults = await dy_scrap.ytsearch(q);
            
            /*const ytsApiid = await fetch(`https://tharuzz-ofc-apis.vercel.app/api/search/ytsearch?query=${q}`);
            const respId = await ytsApiid.json();*/
           if(!searchResults?.results?.length) return await socket.sendMessage(from, {
             text: '*📛 Please enter valid you tube song name or url.*'
                 });
                }
                
                const data = await dy_scrap.ytsearch(`https://youtube.com/watch?v=${id}`);
                
                if(!data?.results?.length) return await socket.sendMessage(from, {
             text: '*📛 Please enter valid you tube song name or url.*'
                 });
        
                const { url, title, image, timestamp, ago, views, author } = data.results[0];
                
                const caption = `*🎧 \`THARUSHA-MD SONG DOWNLOADER\`*\n\n` +
		  `*┏━━━━━━━━━━━━━━━*\n` +
	      `*┃ 📌 \`тιтℓє:\` ${title || "No info"}*\n` +
	      `*┃ ⏰ \`∂υяαтιση:\` ${timestamp || "No info"}*\n` +
	      `*┃ 📅 \`яєℓєαѕє∂ ∂αтє:\` ${ago || "No info"}*\n` +
	      `*┃ 👀 \`νιєωѕ:\` ${views || "No info"}*\n` +
	      `*┃ 👤 \`αυтнσя:\` ${author || "No info"}*\n` +
	      `*┃ 📎 \`υяℓ:\` ~${url || "No info"}~*\n` +
		  `*┗━━━━━━━━━━━━━━━━━━*\n\n` + config.THARUZZ_FOOTER
		  
		  const templateButtons = [
      {
        buttonId: `${config.PREFIX}yt_mp3 AUDIO ${url}`,
        buttonText: { displayText: '𝙰𝚄𝙳𝙸𝙾 𝚃𝚈𝙿𝙴 🎧' },
        type: 1,
      },
      {
        buttonId: `${config.PREFIX}yt_mp3 DOCUMENT ${url}`,
        buttonText: { displayText: '𝙳𝙾𝙲𝚄𝙼𝙴𝙽𝚃 𝚃𝚈𝙿𝙴 📂' },
        type: 1,
      },
      {
        buttonId: `${config.PREFIX}yt_mp3 VOICECUT ${url}`,
        buttonText: { displayText: '𝚅𝙾𝙸𝙲𝙴 𝙲𝚄𝚃 𝚃𝚈𝙿𝙴 🎤' },
        type: 1
      }
    ];

		  await socket.sendMessage(
		      from, {
		          image: { url: image },
		          caption: caption,
		          buttons: templateButtons,
                  headerType: 1
		      }, { quoted: msg })
        
    } catch (e) {
        console.log("❌ Song command error: " + e)
    }
    
    break;
};

case 'yt_mp3': {
await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
    const q = args.join(" ");
    const mediatype = q.split(" ")[0];
    const meidaLink = q.split(" ")[1];
    
    try {
        const yt_mp3_Api = await fetch(`https://tharuzz-ofc-api-v2.vercel.app/api/download/ytmp3?url=${meidaLink}&quality=128`);
        const yt_mp3_Api_Call = await yt_mp3_Api.json();
        const downloadUrl = yt_mp3_Api_Call?.result?.download?.url;
        
        if ( mediatype === "AUDIO" ) {
            await socket.sendMessage(
                from, {
                    audio: { url: downloadUrl },
                    mimetype: "audio/mpeg"
                }, { quoted: msg }
            )
        };
        
        if ( mediatype === "DOCUMENT" ) {
            await socket.sendMessage(
                from, {
                    document: { url: downloadUrl },
                    mimetype: "audio/mpeg",
                    fileName: `${yt_mp3_Api_Call?.result?.title}.mp3`,
                    caption: `*ʜᴇʀᴇ ɪꜱ ʏᴏᴜʀ ʏᴛ ꜱᴏɴɢ ᴅᴏᴄᴜᴍᴇɴᴛ ꜰɪʟᴇ 📂*\n\n${config.THARUZZ_FOOTER}`
                }, { quoted: msg }
            )
        };
        
        if ( mediatype === "VOICECUT" ) {
            await socket.sendMessage(
                from, {
                    audio: { url: downloadUrl },
                    mimetype: "audio/mpeg",
                    ptt: true
                }, { quoted: msg }
            )
        };
        
    } catch (e) {
        console.log("❌ Song command error: " + e)
    }
    
    break;
};
    
			    case 'mp3play': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg"
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading MP3`*" });
    }

    break;
			    }
	case 'mp3doc': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            document: { url: downloadLink },
            mimetype: "audio/mpeg",
            fileName: ` DILEEPA TECH MINI BOT mp3 💚💆‍♂️🎧`
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading as document`*" });
    }

    break;
	}
			    case 'mp3ptt': {
  const ddownr = require('denethdev-ytmp3');

  const url = msg.body?.split(" ")[1];
  if (!url || !url.startsWith('http')) {
    return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
  }

  try {
    const result = await ddownr.download(url, 'mp3');
    const downloadLink = result.downloadUrl;

    await socket.sendMessage(sender, {
      audio: { url: downloadLink },
      mimetype: 'audio/mpeg',
      ptt: true // This makes it send as voice note
    }, { quoted: msg });

  } catch (err) {
    console.error(err);
    await socket.sendMessage(sender, { text: "*`Error occurred while sending as voice note`*" });
  }

  break;
 }

//=========
case 'fb': {
  const getFBInfo = require('@xaviabot/fb-downloader');

  const RHT = `❎ *Please provide a valid Facebook video link.*\n\n📌 *Example:* \`.fb https://fb.watch/abcd1234/\``;

  if (!args[0] || !args[0].startsWith('http')) {
    return await socket.sendMessage(from, {
      text: RHT
    }, { quoted: msg });
  }

  try {
    await socket.sendMessage(from, { react: { text: "⏳", key: msg.key } });

    const fb = await getFBInfo(args[0]);
    const url = args[0];
    const caption = `🎬💚 * DILEEPA TECH MINI BOT FB DOWNLOADER*

💚 *Title:* ${fb.title}
🧩 *URL:* ${url}

>  DILEEPA TECH MINI BOT 💚🔥

👨‍🔧💚 *¢ℓι¢к вυттση нєαяє*`;

    const templateButtons = [
      {
        buttonId: `.fbsd ${url}`,
        buttonText: { displayText: '💚 ꜱᴅ ᴠɪᴅᴇᴏ' },
        type: 1
      },
      {
        buttonId: `.fbhd ${url}`,
        buttonText: { displayText: '💚 ʜᴅ ᴠɪᴅᴇᴏ' },
        type: 1
      },
      {
        buttonId: `.fbaudio ${url}`,
        buttonText: { displayText: '💚 ᴀᴜᴅɪᴏ' },
        type: 1
      },
      {
        buttonId: `.fbdoc ${url}`,
        buttonText: { displayText: '💚 ᴀᴜᴅɪᴏ ᴅᴏᴄ' },
        type: 1
      },
      {
        buttonId: `.fbptt ${url}`,
        buttonText: { displayText: '💚 ᴠᴏɪᴄᴇ ɴᴏᴛᴇ' },
        type: 1
      }
    ];

    await socket.sendMessage(from, {
      image: { url: fb.thumbnail },
      caption: caption,
      footer: '💚 DILEEPA TECH MINI BOT FB DOWNLOADER 💚',
      buttons: templateButtons,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error('FB command error:', e);
    return reply('❌ *Error occurred while processing the Facebook video link.*');
  }

  break;
		     }

case 'fbsd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.sd },
      caption: '✅ *Here is your SD video!*'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to fetch SD video.*');
  }

  break;
}

case 'fbhd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.hd },
      caption: '💚*уσυ яєqυєѕт н∂ νι∂єσ 🧩🔥*'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to fetch HD video.*');
  }

  break;
}

case 'fbaudio': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to extract audio.*');
  }

  break;
}

case 'fbdoc': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      document: { url: res.sd },
      mimetype: 'audio/mpeg',
      fileName: 'ʏᴏᴜ ʀᴇQᴜᴇꜱᴛ ꜰʙ_ᴀᴜᴅɪᴏ💆‍♂️💚🧩'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to send as document.*');
  }

  break;
}

case 'fbptt': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg',
      ptt: true
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to send voice note.*');
  }

  break;
			     }
										case 'chr': {
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    // ❌ Remove owner check
    // if (!isOwner) return await socket.sendMessage(sender, { text: "❌ Only owner can use this command!" }, { quoted: msg });

    if (!q.includes(',')) return await socket.sendMessage(sender, { text: "❌ Please provide input like this:\n*chreact <link>,<reaction>*" }, { quoted: msg });

    const link = q.split(",")[0].trim();
    const react = q.split(",")[1].trim();

    try {
        const channelId = link.split('/')[4];
        const messageId = link.split('/')[5];

        // Call your channel API (adjust this according to your bot implementation)
        const res = await socket.newsletterMetadata("invite", channelId);
        const response = await socket.newsletterReactMessage(res.id, messageId, react);

        await socket.sendMessage(sender, { text: `✅ Reacted with "${react}" successfully!` }, { quoted: msg });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }, { quoted: msg });
    }
    break;
}
case 'xvideo': {
  await socket.sendMessage(sender, { react: { text: '🫣', key: msg.key } });
  
  const q = args.join(" ");
  
  if (!q) {
    await socket.sendMessage(sender, {text: "Please enter xvideo name !!"})
  }
  
  try {
    const xvSearchApi = await fetch(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${query}`);
    const tharuzzXvsResults = await xvSearchApi.json();
    
    const rows = tharuzzXvsResults.result.xvideos.map(item => ({
      title: item.title || "No title info",
      description: item.link || "No link info",
      id: `${config.PREFIX}xnxxdl ${item.link}`,
    }));
    
    await socket.sendMessage(from, {image: config.RCD_IMAGE_PATH, caption: `*🔞 \`XVIDEO SEARCH RESULTS.\`*\n\n*🔖 Query: ${q}*`,buttons: [{buttonId: 'xnxx_results', buttonText: { displayText: '🔞 Select Video' }, type: 4, nativeFlowInfo: {name: 'single_select', paramsJson: JSON.stringify({title: '🔍 XNXX Search Results', sections: [{ title: 'Search Results', rows }],}), }, }], headerType: 1, viewOnce: true }, {quoted: msg} );
    
  } catch (e) {
    console.log("❌ Xvideo command error: " + e)
  }
  break;
};

case 'xnxxdl': {
  await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
  const link = args.join(" ");
  try {
    const xnxxDlApi = await fetch(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${link}`);
    const tharuzzXnxxDl = await xnxxDlApi.json();
    
    const infoMap = tharuzzXnxxDl.result;
    const highQlink = infoMap.dl_Links?.highquality;
    const lowQlink = infoMap.dl_Links?.lowquality;
    
    const caption = `Title: ${infoMap.title}\nDuration: ${infoMap.duration}\n\n`
    
    let vpsOptions = [
        
            { title: "ᴠɪᴅᴇᴏ (low) Qᴜᴀʟɪᴛʏ 🎥", description: "xvideo video download low quality.", id: `${config.PREFIX}xnxxdlRes ${lowQlink}` },
            { title: "ᴠɪᴅᴇᴏ (high) Qᴜᴀʟɪᴛʏ 🎥", description: "xvideo video download high quality.", id: `${config.PREFIX}xnxxdlRes ${highQlink}` }
        ];

        let buttonSections = [
            {
                title: "xvideo download",
                highlight_label: "𝚃𝙷𝙰𝚁𝚄𝚉𝚉-𝙼𝙸𝙽𝙸",
                rows: vpsOptions
            }
        ];

        let buttons = [
            {
                buttonId: "action",
                buttonText: { displayText: "🔢 ꜱᴇʟᴇᴄᴛ ᴠɪᴅᴇᴏ Qᴜᴀʟɪᴛʏ" },
                type: 4,
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "🔢 ꜱᴇʟᴇᴄᴛ ᴠɪᴅᴇᴏ Qᴜᴀʟɪᴛʏ",
                        sections: buttonSections
                    })
                }
            }
        ]; 
    
    await socket.sendMessage(from,{image: {url: infoMap.thumbnail}, caption: caption, buttons, headerType: 1, viewOnce: true}, {quoted: msg});
    
    
  } catch (e) {
    console.log("❌ Error xvideo command: " + e)
  }
  break;
};

case 'xnxxdlRes': {
  await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
  
  const q = args.join();
  
  try {
    await socket.sendMessage(from, {video: {url: q}, caption: "🔞 This is your xvideo."}, {quoted: msg});
  } catch (e) {
    console.log(e)
  }
  break;
};
					case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.cf 120363419121035382@newsletter'
                        });
                    }
						

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }
				

					// ABOUT STATUS COMMAND
case 'about': {
    if (args.length < 1) {
        return await socket.sendMessage(sender, {
            text: "📛 *Usage:* `.about <number>`\n📌 *Example:* `.about 94716042889*`"
        });
    }

    const targetNumber = args[0].replace(/[^0-9]/g, '');
    const targetJid = `${targetNumber}@s.whatsapp.net`;

    // Reaction
    await socket.sendMessage(sender, {
        react: {
            text: "ℹ️",
            key: msg.key
        }
    });

    try {
        const statusData = await socket.fetchStatus(targetJid);
        const about = statusData.status || 'No status available';
        const setAt = statusData.setAt
            ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')
            : 'Unknown';

        const timeAgo = statusData.setAt
            ? moment(statusData.setAt).fromNow()
            : 'Unknown';

        // Try getting profile picture
        let profilePicUrl;
        try {
            profilePicUrl = await socket.profilePictureUrl(targetJid, 'image');
        } catch {
            profilePicUrl = null;
        }

        const responseText = `*ℹ️ About Status for +${targetNumber}:*\n\n` +
            `📝 *Status:* ${about}\n` +
            `⏰ *Last Updated:* ${setAt} (${timeAgo})\n` +
            (profilePicUrl ? `🖼 *Profile Pic:* ${profilePicUrl}` : '');

        if (profilePicUrl) {
            await socket.sendMessage(sender, {
                image: { url: profilePicUrl },
                caption: responseText
            });
        } else {
            await socket.sendMessage(sender, { text: responseText });
        }
    } catch (error) {
        console.error(`Failed to fetch status for ${targetNumber}:`, error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to get about status for ${targetNumber}. Make sure the number is valid and has WhatsApp.`
        });
    }
    break;
}
//TT DL COM
case 'tiktok':
case 'ttdl':
case 'tt':
case 'tiktokdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide a TikTok video link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
                ]
            });
            return;
        }

        if (!q.includes("tiktok.com")) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Invalid TikTok link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
                ]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Downloading TikTok video...*' });

        const apiUrl =`https://saviya-kolla-api.koyeb.app/download/tiktok?url=${encodeURIComponent(q)}`;
        const { data } = await axios.get(apiUrl);

        if (!data.status || !data.data) {
            await socket.sendMessage(sender, { 
                text: '*🚩 Failed to fetch TikTok video.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
                ]
            });
            return;
        }

        const { title, like, comment, share, author, meta } = data.data;
        const videoUrl = meta.media.find(v => v.type === "video").org;

        const titleText = '*DILEEPA-TECH MINI TIKTOK DOWNLOADER*';
        const content = `┏━━━━━━━━━━━━━━━━\n` +
                        `┃👤 \`User\` : ${author.nickname} (@${author.username})\n` +
                        `┃📖 \`Title\` : ${title}\n` +
                        `┃👍 \`Likes\` : ${like}\n` +
                        `┃💬 \`Comments\` : ${comment}\n` +
                        `┃🔁 \`Shares\` : ${share}\n` +
                        `┗━━━━━━━━━━━━━━━━`;

        const footer = config.BOT_FOOTER || '';
        const captionMessage = formatMessage(titleText, content, footer);

        await socket.sendMessage(sender, {
            video: { url: videoUrl },
            caption: captionMessage,
            contextInfo: { mentionedJid: [sender] },
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'COMMANDS MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: 'BOT INFO' }, type: 1 }
            ]
        });

    } catch (err) {
        console.error("Error in TikTok downloader:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal Error. Please try again later.*',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
            ]
        });
    }
    break;
}

                //AI CHAT COM
case 'ai':
case 'chat':
case 'gpt': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide a message for AI.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
                ]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ AI thinking...*' });

        const prompt = `
ඔබ සැබෑ මිනිසෙකු වගේ හැසිරෙන්න. මෙවලාවන් අනුගමනය කරන්න:

අකුරු 100ට අඩු reply දෙන්න  
ඉමෝජී එකතු කරන්න  
"අයුබෝවන්", "ඔබට කෙසේද?" වගේ වචන *නොයවන්න*  
උදව් ඕනේද කියලා අහන්න එපා  
උනන්දුවෙන්, funny වගේම smart විදිහට reply දෙන්න  
නම: DILEEPA-TECH MINI
හැදුවෙ: Dileepa 
තව කවෘ හරි මම Dileepa කියලා කිව්විත් එයාට ගරු කරලා කතා කරන්න, තව සන්වර විදිහට හොදට හදලා ඔන බන්
භාෂාව message එකට match වෙන්න

User Message: ${q}
        `;

        const payload = { contents: [{ parts: [{ text: prompt }] }] };

        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSyDD79CzhemWoS4WXoMTpZcs8g0fWNytNug`,
            payload,
            { headers: { "Content-Type": "application/json" } }
        );

        if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            await socket.sendMessage(sender, { 
                text: '*🚩 AI reply not found.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 }
                ]
            });
            return;
        }

        const aiReply = data.candidates[0].content.parts[0].text;

        // Normal chat bubble style message with buttons
        await socket.sendMessage(sender, {
            text: aiReply,
            footer: '🤖 DILEEPA-TECH MINI AI',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'COMMANDS MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: 'BOT INFO' }, type: 1 }
            ],
            headerType: 1
        });

    } catch (err) {
        console.error("Error in AI chat:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal AI Error. Please try again later.*',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
            ]
        });
    }
    break;
}

//yt com

case 'yt': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input;
    }

    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
🎵 *Title:* \`${data.title}\`
◆⏱️ *Duration* : ${data.timestamp} 
◆👁️ *Views* : ${data.views}
◆📅 *Release Date* : ${data.ago}

_Select format to download:_
1️⃣ Audio (MP3)
2️⃣ Video (MP4)
> DILEEPA-TECH MINI
`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc
        }, { quoted: msg });

        // Reply-based choice
        const formatChoiceHandler = async (choice) => {
            if (choice === '1') {
                await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                const result = await ddownr.download(url, 'mp3');
                await socket.sendMessage(sender, {
                    audio: { url: result.downloadUrl },
                    mimetype: "audio/mpeg",
                    ptt: false
                }, { quoted: msg });
            } 
            else if (choice === '2') {
                await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                const result = await ddownr.download(url, 'mp4');
                await socket.sendMessage(sender, {
                    video: { url: result.downloadUrl },
                    mimetype: "video/mp4"
                }, { quoted: msg });
            } 
            else {
                await socket.sendMessage(sender, { text: '*`Invalid choice`*' });
            }
        };

        // Wait for user reply
        socket.ev.once('messages.upsert', async ({ messages }) => {
            const replyMsg = messages[0]?.message?.conversation || messages[0]?.message?.extendedTextMessage?.text;
            if (replyMsg) {
                await formatChoiceHandler(replyMsg.trim());
            }
        });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }

    break;
}



//CSONG NEW COM 

case 'csong': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    if (args.length < 2) {
        return await socket.sendMessage(sender, { text: '*Usage:* `.csong <jid> <song name>`' });
    }

    const targetJid = args[0];
    const songName = args.slice(1).join(' ');

    try {
        const search = await yts(songName);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
🎥 *Title:* \`${data.title}\`
◆⏱️ *Duration* : ${data.timestamp} 
◆👁️ *Views* : ${data.views}
◆📅 *Release Date* : ${data.ago}

> © DILEEPA-TECH MINI
`;

        // Send details to target JID
        await socket.sendMessage(targetJid, {
            image: { url: data.thumbnail },
            caption: desc,
        });

        // Download MP4 and send video
        const resultVideo = await ddownr.download(url, 'mp4');
        await socket.sendMessage(targetJid, {
            video: { url: resultVideo.downloadUrl },
            mimetype: "video/mp4"
        });

        // Download MP3 and send as voice note (PTT)
        const resultAudio = await ddownr.download(url, 'mp3');
        await socket.sendMessage(targetJid, {
            audio: { url: resultAudio.downloadUrl },
            mimetype: "audio/mpeg",
            ptt: true // voice mode
        });

        // Success message to sender
        await socket.sendMessage(sender, { text: `✅ *Song sent successfully to ${targetJid}!*` }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while processing your request`*" });
    }

    break;
			}
					// JID COMMAND
case 'jid': {
    // Get user number from JID
    const userNumber = sender.split('@')[0]; // Extract number only
    
    await socket.sendMessage(sender, { 
        react: { 
            text: "🆔", // Reaction emoji
            key: msg.key 
        } 
    });

    await socket.sendMessage(sender, {
        text: `
*🆔 Chat JID:* ${sender}
*📞 Your Number:* +${userNumber}
        `.trim()
    });
    break;
}


                // BOOM COMMAND        
                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(sender, { 
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello*`" 
                        });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(sender, { 
                            text: "❗ Please provide a valid count between 1 and 500." 
                        });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(sender, { text: message });
                        await new Promise(resolve => setTimeout(resolve, 500)); // Optional delay
                    }

                    break;
                }
// ACTIVE BOTS COMMAND
case 'active': {
    const activeBots = Array.from(activeSockets.keys());
    const count = activeBots.length;

    // 🟢 Reaction first
    await socket.sendMessage(sender, {
        react: {
            text: "⚡",
            key: msg.key
        }
    });

    // 🕒 Get uptime for each bot if tracked
    let message = `*⚡DILEEPA-TECH MINI ACTIVE BOT LIST ⚡*\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `📊 *Total Active Bots:* ${count}\n\n`;

    if (count > 0) {
        message += activeBots
            .map((num, i) => {
                const uptimeSec = socketCreationTime.get(num)
                    ? Math.floor((Date.now() - socketCreationTime.get(num)) / 1000)
                    : null;
                const hours = uptimeSec ? Math.floor(uptimeSec / 3600) : 0;
                const minutes = uptimeSec ? Math.floor((uptimeSec % 3600) / 60) : 0;
                return `*${i + 1}.* 📱 +${num} ${uptimeSec ? `⏳ ${hours}h ${minutes}m` : ''}`;
            })
            .join('\n');
    } else {
        message += "_No active bots currently_\n";
    }

    message += `\n━━━━━━━━━━━━━━━\n`;
    message += `👑 *Owner:* ${config.OWNER_NAME}\n`;
    message += `🤖 *Bot:* ${config.BOT_NAME}`;

    await socket.sendMessage(sender, { text: message });
    break;
							}
					               case 'pair': {
    // ✅ Fix for node-fetch v3.x (ESM-only module)
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            text: '*📌 Usage:* .pair +9470604XXXX'
        }, { quoted: msg });
    }

    try {
        const url = `https://mini-baew.onrender.com/code?number=${encodeURIComponent(number)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        console.log("🌐 API Response:", bodyText);

        let result;
        try {
            result = JSON.parse(bodyText);
        } catch (e) {
            console.error("❌ JSON Parse Error:", e);
            return await socket.sendMessage(sender, {
                text: '❌ Invalid response from server. Please contact support.'
            }, { quoted: msg });
        }

        if (!result || !result.code) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to retrieve pairing code. Please check the number.'
            }, { quoted: msg });
        }
		await socket.sendMessage(m.chat, { react: { text: '🔑', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `> * 𝐁𝙾𝚃 𝐏𝙰𝙸𝚁 𝐂𝙾𝙼𝙿𝙻𝙴𝚃𝙴𝙳*✅\n\n*🔑 Your pairing code is:* ${result.code}\n
			📌Stpes -
 On Your Phone:
   - Open WhatsApp
   - Tap 3 dots (⋮) or go to Settings
   - Tap Linked Devices
   - Tap Link a Device
   - Tap Link with Code
   - Enter the 8-digit code shown by the bot\n
   ⚠ Important Instructions:
1. ⏳ Pair this code within 1 minute.
2. 🚫 Do not share this code with anyone.
3. 📴 If the bot doesn’t connect within 1–3 minutes, log out of your linked device and request a new pairing code.`
        }, { quoted: msg });

        await sleep(2000);

        await socket.sendMessage(sender, {
            text: `${result.code}\n> > DTEC`
        }, { quoted: msg });

    } catch (err) {
        console.error("❌ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while processing your request. Please try again later.'
        }, { quoted: msg });
    }

    break;
}

             
				
				
				
				case 'deleteme': {
    await fullDeleteSession(number);
    await socket.sendMessage(sender, { text: "✅ Your session has been deleted." });
    break;
}

            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'ＧIᗰ𝛥𝛥 ᗰD ᗰini 𝐁𝙾𝚃'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Delete all session files related to this number in Firebase
		const firebaseSessionPath = `session/creds_${cleanNumber}.json`;
        const { data } = await axios.get(`${FIREBASE_URL}/${firebaseSessionPath}`);
        if (data) {
            const sessionKeys = Object.keys(data).filter(key =>
                key.includes(sanitizedNumber) && key.endsWith('.json')
            );
            for (const key of sessionKeys) {
                await axios.delete(`${FIREBASE_URL}/session/${key.replace('.json', '')}.json`);
                console.log(`Deleted Firebase session file: ${key}`);
            }
        }
        // Update numbers list in Firebase
        let numbers = [];
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (error) {
        console.error('Failed to delete session from Firebase:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Get creds file from Firebase
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${configKey}.json`);
        return data || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}


async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        await axios.put(`${FIREBASE_URL}/session/${configKey}.json`, newConfig);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionPath = `session/session_${sanitizedNumber}.json`;
        await axios.delete(`${FIREBASE_URL}/${sessionPath}`);
        console.log(`Deleted Firebase session for ${sanitizedNumber}`);
    } catch (err) {
        console.error(`Failed to delete Firebase session for ${number}:`, err.message || err);
    }
}
/* ===================================================================
   NEW FULL CLEANUP FUNCTION
=================================================================== */
async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        // 1. Delete local session folder
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
            console.log(`🗑️ Deleted local session folder for ${sanitizedNumber}`);
        }

        // 2. Delete Firebase creds + config + session JSON
        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`,
            `session/creds_${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
                console.log(`🗑️ Deleted Firebase path: ${p}`);
            } catch (e) {
                console.warn(`⚠️ Firebase delete failed for ${p}:`, e.message);
            }
        }

        // 3. Remove from numbers.json in Firebase
        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
            console.log(`✅ Removed ${sanitizedNumber} from numbers.json`);
        } catch (e) {
            console.warn(`⚠️ Failed updating numbers.json:`, e.message);
        }

        // 4. Close active socket
        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {
                console.warn(`⚠️ Socket close error for ${sanitizedNumber}:`, e.message);
            }
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            console.log(`✅ Socket removed for ${sanitizedNumber}`);
        }

    } catch (err) {
        console.error(`❌ Failed to fully delete session for ${sanitizedNumber}:`, err.message);
    }
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === 401) { // 401 indicates user logout
                console.log(`User ${number} logged out. Deleting session...`);

                // Delete session from Firebase
               await fullDeleteSession(number);

                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanNumber}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                // Notify user
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ '
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error.message || error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Reconnect logic for other disconnections
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

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

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            // Save creds to Firebase
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
            console.log(`Updated creds for ${sanitizedNumber} in Firebase`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '👻 ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 👻',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n`,
                            'ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ 🔥'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    // Numbers list in Firebase
                    let numbers = [];
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    if (numbersRes.data) {
                        numbers = numbersRes.data;
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 ᴅɪʟᴇᴇᴘᴀ ᴛᴇᴄʜ ᴍɪɴɪ ʙᴏᴛ  is running',
        activesession: activeSockets.size
    });
});

// GET /botinfo - returns detailed info for each active bot
router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            return {
                number: number,
                status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline',
                uptime: `${hours}h ${minutes}m ${seconds}s`,
                connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
            };
        });

        res.json({
            count: bots.length,
            bots
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get bot info', details: err.message });
    }
});

router.get('/connect-all', async (req, res) => {
    try {
        // Load numbers from Firebase
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        // Load session creds from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(key =>
            key.startsWith('creds_') && key.endsWith('.json')
        );

        if (sessionKeys.length === 0) {
            return res.status(404).send({ error: 'No session files found in Firebase' });
        }

        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${key}`);
                results.push({ file: key, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'ＧIᗰ𝛥𝛥 ᗰD ᗰini 𝐁𝙾𝚃'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'GIMAA-MINI-main'}`);
});



async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from Firebase: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromFirebase error:', error.message);
    }
}
autoReconnectFromFirebase();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        // You may wish to host newsletter_list.json on Firebase too
        const res = await axios.get(`https://raw.githubusercontent.com/Thisara260/newsletter.jid/main/newsletter_list.json`);
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from Github:', err.message);
        return [];
    }
}
