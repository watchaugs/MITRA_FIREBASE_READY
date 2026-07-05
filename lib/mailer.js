'use strict';

/**
 * lib/mailer.js — Nodemailer transporter + email templates
 * Responsibility: SENDING ONLY. Token generation and Firestore writes
 * stay in the route that calls these functions.
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be set in environment');
  }
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST     || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE   === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return _transporter;
}

/**
 * Low-level send. Used by all higher-level helpers.
 */
async function sendMail({ to, subject, html }) {
  const transporter = getTransporter();
  return transporter.sendMail({
    from: process.env.SMTP_FROM || '"MITRA Dashboard" <no-reply@mitra.gov.in>',
    to,
    subject,
    html,
  });
}

/**
 * Sent when a new dashboard user is created.
 * The caller (users.js) has already written the token to Firestore.
 */
async function sendWelcomeEmail({ to, full_name, role, setupUrl }) {
  const roleLabel = (role || 'viewer').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return sendMail({
    to,
    subject: 'Welcome to MITRA — Set Up Your Password',
    html: `
      <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:auto;background:#07090f;color:#f1f5f9;padding:40px 32px;border-radius:12px;border:1px solid #1e293b">
        <div style="font-size:26px;font-weight:700;letter-spacing:1px;margin-bottom:4px;color:#ffffff">MITRA</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:32px">Dashboard Access</div>
        <p style="margin:0 0 12px;font-size:15px">Hi <strong>${full_name}</strong>,</p>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8">
          Your MITRA dashboard account has been created with the role
          <strong style="color:#f1f5f9">${roleLabel}</strong>.
          Click below to set your password and activate your account.
        </p>
        <a href="${setupUrl}"
           style="display:inline-block;padding:14px 28px;background:#4f46e5;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
          Set My Password →
        </a>
        <p style="margin:28px 0 0;font-size:12px;color:#475569">
          This link expires in <strong>24 hours</strong>. If you didn't expect this email, you can safely ignore it.
        </p>
        <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0">
        <p style="margin:0;font-size:11px;color:#334155">MITRA · WatchAugs · Secure Government Dashboard</p>
      </div>
    `,
  });
}

/**
 * Sent when an existing user requests a password reset.
 * The caller (auth.js) has already written the token to Firestore.
 */
async function sendResetEmail({ to, resetUrl }) {
  return sendMail({
    to,
    subject: 'MITRA Dashboard — Password Reset Request',
    html: `
      <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:auto;background:#07090f;color:#f1f5f9;padding:40px 32px;border-radius:12px;border:1px solid #1e293b">
        <div style="font-size:26px;font-weight:700;letter-spacing:1px;margin-bottom:4px;color:#ffffff">MITRA</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:32px">Password Reset</div>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8">
          A password reset was requested for your account. Click below to choose a new password.
        </p>
        <a href="${resetUrl}"
           style="display:inline-block;padding:14px 28px;background:#4f46e5;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
          Reset My Password →
        </a>
        <p style="margin:28px 0 0;font-size:12px;color:#475569">
          This link expires in <strong>1 hour</strong>. If you didn't request a reset, you can safely ignore this.
        </p>
        <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0">
        <p style="margin:0;font-size:11px;color:#334155">MITRA · WatchAugs · Secure Government Dashboard</p>
      </div>
    `,
  });
}

module.exports = { sendMail, sendWelcomeEmail, sendResetEmail };