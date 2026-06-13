import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const inputSchema = z.object({
  action: z.enum([
    'send',        // send an email
    'list',        // list inbox messages
    'read',        // read a specific email
    'search',      // search emails
    'reply',       // reply to an email
  ]),
  // send / reply
  to:       z.string().optional().describe('Recipient email address'),
  subject:  z.string().optional().describe('Email subject'),
  body:     z.string().optional().describe('Email body (plain text)'),
  reply_to_uid: z.number().optional().describe('UID of email to reply to'),
  // list / search
  folder:   z.string().optional().default('INBOX').describe('Mailbox folder'),
  limit:    z.number().optional().default(10).describe('Max emails to return'),
  query:    z.string().optional().describe('Search query (e.g. "from:boss subject:meeting")'),
  // read
  uid:      z.number().optional().describe('Email UID to read'),
});

type Input = z.infer<typeof inputSchema>;

interface EmailConfig {
  user: string;
  password: string;
  imapHost: string;
  smtpHost: string;
  smtpPort: number;
}

function getConfig(): EmailConfig | null {
  const user     = process.env.EMAIL_USER;
  const password = process.env.EMAIL_PASSWORD;
  if (!user || !password) return null;

  // Auto-detect provider from email domain
  const domain = user.split('@')[1]?.toLowerCase() ?? '';
  const isGmail   = domain === 'gmail.com';
  const isOutlook = domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com';

  return {
    user,
    password,
    imapHost: isGmail   ? 'imap.gmail.com'
             : isOutlook ? 'outlook.office365.com'
             : `imap.${domain}`,
    smtpHost: isGmail   ? 'smtp.gmail.com'
             : isOutlook ? 'smtp.office365.com'
             : `smtp.${domain}`,
    smtpPort: 587,
  };
}

export class EmailTool implements ITool<Input> {
  readonly name = 'email';
  readonly description =
    'Access and manage email. Send messages, read inbox, search emails. ' +
    'Requires EMAIL_USER and EMAIL_PASSWORD (Gmail App Password) in environment.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    if (!config) {
      return {
        success: false,
        error: 'Email not configured. Send your Gmail app password via Telegram to set it up.',
      };
    }

    try {
      switch (input.action) {
        case 'send':   return await this.#send(input, config);
        case 'list':   return await this.#list(input, config);
        case 'read':   return await this.#read(input, config);
        case 'search': return await this.#search(input, config);
        case 'reply':  return await this.#reply(input, config);
        default:       return { success: false, error: 'Unknown action' };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────────
  async #send(input: Input, cfg: EmailConfig): Promise<ToolResult> {
    if (!input.to || !input.subject || !input.body) {
      return { success: false, error: 'send requires: to, subject, body' };
    }
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: false,
      auth: { user: cfg.user, pass: cfg.password },
    });
    await transporter.sendMail({
      from: cfg.user,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
    return { success: true, data: `Email sent to ${input.to} — subject: "${input.subject}"` };
  }

  // ── List ────────────────────────────────────────────────────────────────────
  async #list(input: Input, cfg: EmailConfig): Promise<ToolResult> {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({ host: cfg.imapHost, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false });
    await client.connect();

    const lock = await client.getMailboxLock(input.folder ?? 'INBOX');
    const emails: Array<{ uid: number; from: string; subject: string; date: string; seen: boolean }> = [];

    try {
      const limit = input.limit ?? 10;
      // Fetch most recent N messages
      for await (const msg of client.fetch(`${Math.max(1, (client.mailbox as { exists: number }).exists - limit + 1)}:*`, {
        uid: true, envelope: true, flags: true,
      })) {
        emails.push({
          uid:     msg.uid,
          from:    msg.envelope?.from?.[0]?.address ?? 'unknown',
          subject: msg.envelope?.subject ?? '(sin asunto)',
          date:    msg.envelope?.date?.toISOString().slice(0, 16) ?? '',
          seen:    msg.flags?.has('\\Seen') ?? false,
        });
      }
    } finally {
      lock.release();
      await client.logout();
    }

    emails.reverse(); // newest first
    return { success: true, data: emails };
  }

  // ── Read ────────────────────────────────────────────────────────────────────
  async #read(input: Input, cfg: EmailConfig): Promise<ToolResult> {
    if (!input.uid) return { success: false, error: 'read requires uid' };

    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({ host: cfg.imapHost, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false });
    await client.connect();

    const lock = await client.getMailboxLock(input.folder ?? 'INBOX');
    let result: ToolResult = { success: false, error: 'Email not found' };

    try {
      for await (const msg of client.fetch({ uid: input.uid }, { uid: true, envelope: true, bodyParts: ['TEXT'], flags: true })) {
        const textPart = msg.bodyParts?.get('TEXT');
        const body = textPart ? Buffer.from(textPart as Uint8Array).toString('utf8').slice(0, 3000) : '';
        result = {
          success: true,
          data: {
            uid:     msg.uid,
            from:    msg.envelope?.from?.[0]?.address ?? 'unknown',
            to:      msg.envelope?.to?.[0]?.address ?? 'unknown',
            subject: msg.envelope?.subject ?? '(sin asunto)',
            date:    msg.envelope?.date?.toISOString().slice(0, 16) ?? '',
            body:    body.trim(),
          },
        };
      }
    } finally {
      lock.release();
      await client.logout();
    }
    return result;
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  async #search(input: Input, cfg: EmailConfig): Promise<ToolResult> {
    if (!input.query) return { success: false, error: 'search requires query' };

    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({ host: cfg.imapHost, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false });
    await client.connect();

    const lock = await client.getMailboxLock(input.folder ?? 'INBOX');
    const emails: Array<{ uid: number; from: string; subject: string; date: string }> = [];

    try {
      // Simple text search across subject and body
      const uids = (await client.search({ text: input.query })) as number[];
      const limited = uids.slice(-(input.limit ?? 10));

      for await (const msg of client.fetch(limited.join(',') || '1', { uid: true, envelope: true })) {
        emails.push({
          uid:     msg.uid,
          from:    msg.envelope?.from?.[0]?.address ?? 'unknown',
          subject: msg.envelope?.subject ?? '(sin asunto)',
          date:    msg.envelope?.date?.toISOString().slice(0, 16) ?? '',
        });
      }
    } finally {
      lock.release();
      await client.logout();
    }
    return { success: true, data: emails.reverse() };
  }

  // ── Reply ───────────────────────────────────────────────────────────────────
  async #reply(input: Input, cfg: EmailConfig): Promise<ToolResult> {
    if (!input.reply_to_uid || !input.body) {
      return { success: false, error: 'reply requires reply_to_uid and body' };
    }

    // First read the original to get reply headers
    const original = await this.#read({ ...input, action: 'read', uid: input.reply_to_uid }, cfg);
    if (!original.success || !original.data) {
      return { success: false, error: 'Could not find original email to reply to' };
    }
    const orig = original.data as { from: string; subject: string };

    return this.#send({
      ...input,
      action: 'send',
      to:      orig.from,
      subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`,
      body:    input.body,
    }, cfg);
  }
}
