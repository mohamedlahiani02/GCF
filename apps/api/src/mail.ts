import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** SMTP mailer from the environment, or null when no SMTP server is configured. */
export function createMailer(config: Config): Mailer | null {
  const smtp = config.smtp;
  if (!smtp) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: smtp.from, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.attachments ? { attachments: mail.attachments } : {}) });
    },
  };
}
