const twilio = require('twilio');
const logger = require('../../config/logger');

let client;

function getTwilioClient() {
    if (!client) {
        client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return client;
}

async function sendSms({ to, body }) {
    if (!to || !body) return;

    try {
        const c = getTwilioClient();
        const msg = await c.messages.create({
            body,
            from: process.env.TWILIO_FROM_NUMBER,
            to,
        });
        logger.info(`SMS sent: ${msg.sid} → ${to}`);
        return msg;
    } catch (err) {
        logger.error('SMS send failed:', err.message);
    }
}

async function sendOtpSms(phone, code) {
    return sendSms({
        to:   phone,
        body: `Your verification code is: ${code}. Valid for 10 minutes. Do not share this code.`,
    });
}

module.exports = { sendSms, sendOtpSms };