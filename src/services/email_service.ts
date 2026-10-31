import { defaultEmailTemplates, resolveEmailTemplate, type EmailTemplateContent } from './email_templates';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export interface EmailParams {
  to: string;
  subject: string;
  html: string;
}

export class EmailService {
  private static getApiKey(): string | undefined {
    return process.env.RESEND_API_KEY;
  }

  private static getSender(): string {
    return process.env.RESEND_SENDER_EMAIL || 'onboarding@resend.dev';
  }

  /**
   * Dispatches a transactional email using Resend REST API or local console fallback.
   */
  static async sendEmail({ to, subject, html }: EmailParams): Promise<{ success: boolean; mode: 'live' | 'mock'; id?: string }> {
    const apiKey = this.getApiKey();
    const sender = this.getSender();

    if (apiKey && apiKey.trim() !== '') {
      try {
        const response = await axios.post(
          'https://api.resend.com/emails',
          {
            from: `Clad Atelier <${sender}>`,
            to,
            subject,
            html,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: 15000,
          }
        );
        return { success: true, mode: 'live', id: response.data?.id };
      } catch (err: any) {
        console.error('[EmailService] Failed to send live Resend email:', err.response?.data || err.message);
        throw err;
      }
    } else {
      // Graceful fallback to Mock Console Logger & Scratch Receipts File
      const timestamp = new Date().toISOString();
      const receipt = {
        timestamp,
        to,
        subject,
        html,
      };

      console.log('────────────────────────────────────────────────────────────');
      console.log(`[EmailService] [MOCK SEND] ${timestamp}`);
      console.log(`To:      ${to}`);
      console.log(`Subject: ${subject}`);
      console.log('────────────────────────────────────────────────────────────');

      try {
        const scratchDir = path.join(__dirname, '../../scratch');
        if (!fs.existsSync(scratchDir)) {
          fs.mkdirSync(scratchDir, { recursive: true });
        }
        const receiptsPath = path.join(scratchDir, 'email_receipts.json');
        let receipts: any[] = [];
        if (fs.existsSync(receiptsPath)) {
          const raw = fs.readFileSync(receiptsPath, 'utf8');
          receipts = JSON.parse(raw);
        }
        receipts.unshift(receipt);
        fs.writeFileSync(receiptsPath, JSON.stringify(receipts, null, 2), 'utf8');
      } catch (fileErr) {
        console.error('[EmailService] Failed to write mock email receipt to scratch file:', fileErr);
      }

      return { success: true, mode: 'mock', id: `mock-${Date.now()}` };
    }
  }

  /**
   * Helper to interpolate variables like {{userName}} inside templates
   */
  static interpolate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, val] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => val);
    }
    return result;
  }

  /**
   * Default templates seeded automatically into the database if missing
   */
  static getDefaultTemplates(): Record<string, EmailTemplateContent> { return defaultEmailTemplates(); }
  static resolveTemplate(id: string, stored?: EmailTemplateContent | null) { return resolveEmailTemplate(id, stored); }
}
