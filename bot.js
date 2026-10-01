const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    downloadMediaMessage,
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ====== تنظیمات ======
const PORT = process.env.PORT || 3000;
const SESSION_DIR = './auth_info';
const MEDIA_DIR = './media';

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ====== وب‌سرور برای Render ======
const app = express();
app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is running!'));

// مسیر QR برای اسکن راحت‌تر روی Render
app.get('/qr', (req, res) => {
    if (global.LATEST_QR) {
        res.send(`
            <h2>Scan this QR with WhatsApp</h2>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(global.LATEST_QR)}" />
        `);
    } else {
        res.send('✅ Bot is already connected or QR not generated yet.');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});

// ====== کش برای جلوگیری از تکرار ======
const processedIds = new Set();
let SELF_JID = null;

// ====== تابع اصلی ======
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    // ====== مدیریت اتصال و QR ======
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            global.LATEST_QR = qr;
            console.log('\n📱 QR رو در مرورگر باز کن: /qr یا توی ترمینال ببین:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 اتصال قطع شد، تلاش مجدد...');
                setTimeout(startBot, 3000);
            } else {
                console.log('❌ از اکانت خارج شدی.');
            }
        } else if (connection === 'open') {
            SELF_JID = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            global.LATEST_QR = null;
            console.log('✅ ربات متصل شد!');
            console.log(`📱 شماره: ${sock.user.id}`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ====== مدیریت پیام‌ها ======
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message || processedIds.has(msg.key.id)) continue;
            processedIds.add(msg.key.id);
            if (processedIds.size > 1000) processedIds.clear();

            // پیدا کردن View Once در ساختارهای مختلف
            let viewOnce = null;
            if (msg.message.viewOnceMessageV2?.message) viewOnce = msg.message.viewOnceMessageV2.message;
            else if (msg.message.viewOnceMessage?.message) viewOnce = msg.message.viewOnceMessage.message;
            else if (msg.message.viewOnceMessageV2Extension?.message) viewOnce = msg.message.viewOnceMessageV2Extension.message;
            else if (msg.message.imageMessage?.viewOnce) viewOnce = msg.message;
            else if (msg.message.videoMessage?.viewOnce) viewOnce = msg.message;

            if (viewOnce) {
                await handleViewOnce(sock, msg, viewOnce, msg.pushName || 'کاربر');
                continue;
            }

            // ====== پیام متنی ======
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text || msg.key.fromMe) continue;

            if (text === 'پینگ') {
                await sock.sendMessage(msg.key.remoteJid, { text: '🏓 پونگ!' }, { quoted: msg });
            } else if (text === 'راهنما') {
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: '🤖 دستورات:\n• پینگ\n• راهنما\n\n📸 برای ذخیره View Once، روی پیام ریپلای کن و بنویس: !dox' 
                }, { quoted: msg });
            }
        }
    });

    // ====== دستور !dox ======
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text || !text.startsWith('!dox')) continue;

            // اگر روی پیامی ریپلای شده باشد
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                let viewOnce = null;
                if (quoted.viewOnceMessageV2?.message) viewOnce = quoted.viewOnceMessageV2.message;
                else if (quoted.viewOnceMessage?.message) viewOnce = quoted.viewOnceMessage.message;
                else if (quoted.imageMessage?.viewOnce) viewOnce = quoted;
                else if (quoted.videoMessage?.viewOnce) viewOnce = quoted;

                if (viewOnce) {
                    await handleViewOnce(sock, msg, viewOnce, msg.pushName || 'کاربر', msg.key.remoteJid);
                } else {
                    await sock.sendMessage(msg.key.remoteJid, { text: '❌ این پیام View Once نیست.' });
                }
            }
        }
    });
}

// ====== تابع پردازش View Once ======
async function handleViewOnce(sock, msg, content, pushName, targetJid = null) {
    const imageMsg = content.imageMessage;
    const videoMsg = content.videoMessage;
    const mediaMsg = imageMsg || videoMsg;

    if (!mediaMsg) return;

    const isImage = !!imageMsg;
    const ext = isImage ? 'jpg' : 'mp4';
    const type = isImage ? 'عکس' : 'ویدیو';

    try {
        const buffer = await downloadMediaMessage(
            { message: content, key: msg.key },
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );

        const filename = `viewonce_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);

        // ارسال به سلف‌چت
        if (SELF_JID) {
            const caption = `🔓 ${type} View Once\n👤 از: ${pushName}`;
            if (isImage) await sock.sendMessage(SELF_JID, { image: buffer, caption });
            else await sock.sendMessage(SELF_JID, { video: buffer, caption });
        }

        // اگر با !dox در چت فرستاده شده، توی همون چت هم بفرست
        if (targetJid) {
            if (isImage) await sock.sendMessage(targetJid, { image: buffer, caption: `🔓 ${type} ذخیره شد` });
            else await sock.sendMessage(targetJid, { video: buffer, caption: `🔓 ${type} ذخیره شد` });
        }

        console.log(`✅ ${type} ذخیره و ارسال شد`);
    } catch (err) {
        console.log('❌ خطا:', err.message);
    }
}

startBot().catch(err => console.error('خطای کلی:', err));
