const nodemailer = require('nodemailer');
const sgTransport = require('nodemailer-sendgrid-transport');
const logger = require('../../config/logger');

const transporter = nodemailer.createTransport(
    sgTransport({ auth: { api_key: process.env.SENDGRID_API_KEY } })
);

const FROM = `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM}>`;

const templates = {
    verifyEmail: (code) => ({
        subject: 'Verify your email address',
        html: `
      <h2>Email Verification</h2>
      <p>Your verification code is:</p>
      <h1 style="letter-spacing:8px;color:#1a4a7a">${code}</h1>
      <p>This code expires in 10 minutes.</p>
    `,
    }),
    passwordReset: (link) => ({
        subject: 'Reset your password',
        html: `
      <h2>Password Reset Request</h2>
      <p>Click the link below to reset your password. It expires in 1 hour.</p>
      <a href="${link}" style="background:#1a4a7a;color:white;padding:12px 24px;text-decoration:none;border-radius:4px">Reset Password</a>
      <p>If you did not request this, please ignore this email.</p>
    `,
    }),
    credentialExpiry: (name, type, days) => ({
        subject: `Credential expiring soon — ${type}`,
        html: `
      <h2>Credential Expiry Alert</h2>
      <p>Hi ${name},</p>
      <p>Your <strong>${type}</strong> credential expires in <strong>${days} days</strong>.</p>
      <p>Please log in and upload an updated document to avoid losing shift access.</p>
    `,
    }),
    shiftBooked: (nurseName, shiftDate, facilityName) => ({
        subject: 'Shift Booking Confirmed',
        html: `
      <h2>Shift Confirmed</h2>
      <p>Hi ${nurseName}, your shift at <strong>${facilityName}</strong> on <strong>${shiftDate}</strong> has been confirmed.</p>
    `,
    }),
    newAssignment: (nurseName, shiftDetails) => ({
        subject: 'New Shift Assignment',
        html: `
      <h2>You've Been Assigned a Shift</h2>
      <p>Hi ${nurseName},</p>
      <p>You have been assigned to a new shift:</p>
      <pre>${JSON.stringify(shiftDetails, null, 2)}</pre>
    `,
    }),
};

async function sendEmail({ to, templateName, templateData = {}, subject, html }) {
    try {
        let content = { subject, html };
        if (templateName && templates[templateName]) {
            content = templates[templateName](...Object.values(templateData));
        }

        await transporter.sendMail({
            from: FROM,
            to,
            subject: content.subject,
            html:    content.html,
        });

        logger.info(`Email sent: ${content.subject} → ${to}`);
    } catch (err) {
        logger.error('Email send failed:', err.message);
        // Non-blocking
    }
}

module.exports = { sendEmail, templates };