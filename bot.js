const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@outlaw1/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const SESSION_DIR = './auth_info';
const MEDIA_DIR = './media';

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ====== وب‌سرور برای Render ======
const app = express();
app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is running!'));

app.get('/qr', (req, res) => {
    if (global.LATEST_QR) {
        res.send(`<h2>Scan this QR</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(global.LATEST_QR)}" />`);
    } else {
        res.send('✅ Connected or QR not ready.');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server on port ${PORT}`));

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
            console.log('\n📱 QR رو در /qr ببین:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 تلاش مجدد...');
                setTimeout(startBot, 3000);
            } else {
                console.log('❌ Logout شدی.');
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
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || processedIds.has(msg.key.id)) continue;
            processedIds.add(msg.key.id);
            if (processedIds.size > 1000) processedIds.clear();

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            console.log('📩 پیام دریافتی:', text, '| fromMe:', msg.key.fromMe);

            // فقط اگه متن نباشه رد کن
            if (!text) continue;

            // ====== دستور !dox (حتی از خودت) ======
            if (text.startsWith('!dox')) {
                console.log('🔍 دستور !dox دریافت شد!');
                
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                console.log('📋 quoted موجود؟', !!quoted);
                
                if (!quoted) {
                    await sock.sendMessage(msg.key.remoteJid, { text: '❌ روی یه پیام ریپلای کن.' }, { quoted: msg });
                    continue;
                }

                console.log('🔑 کلیدهای quoted:', Object.keys(quoted));

                // پیدا کردن View Once
                let viewOnce = null;
                if (quoted.viewOnceMessageV2?.message) viewOnce = quoted.viewOnceMessageV2.message;
                else if (quoted.viewOnceMessage?.message) viewOnce = quoted.viewOnceMessage.message;
                else if (quoted.viewOnceMessageV2Extension?.message) viewOnce = quoted.viewOnceMessageV2Extension.message;
                else if (quoted.imageMessage?.viewOnce) viewOnce = quoted;
                else if (quoted.videoMessage?.viewOnce) viewOnce = quoted;

                console.log('🔓 View Once پیدا شد؟', !!viewOnce);

                if (!viewOnce) {
                    await sock.sendMessage(msg.key.remoteJid, { text: '❌ این پیام View Once نیست.' }, { quoted: msg });
                    continue;
                }

                try {
                    console.log('⏳ در حال دانلود...');
                    const buffer = await sock.rvo(viewOnce);
                    console.log('✅ دانلود شد، حجم:', buffer.length);

                    const isImage = !!(viewOnce.imageMessage || quoted.imageMessage);
                    const type = isImage ? 'عکس' : 'ویدیو';

                    // ارسال به سلف‌چت خودت
                    if (SELF_JID) {
                        const caption = `🔓 ${type} View Once\n👤 از: ${msg.pushName || 'ناشناس'}`;
                        if (isImage) await sock.sendMessage(SELF_JID, { image: buffer, caption });
                        else await sock.sendMessage(SELF_JID, { video: buffer, caption });
                        console.log('📤 به سلف‌چت ارسال شد');
                    }

                    await sock.sendMessage(msg.key.remoteJid, { text: `✅ ${type} توی سلف‌چت ذخیره شد.` }, { quoted: msg });

                } catch (err) {
                    console.log('❌ خطا در rvo:', err.message);
                    console.log('❌ جزئیات:', err.stack);
                    await sock.sendMessage(msg.key.remoteJid, { text: `❌ خطا: ${err.message}` }, { quoted: msg });
                }
            }
        }
    });
}

startBot().catch(err => console.error('خطای کلی:', err));
