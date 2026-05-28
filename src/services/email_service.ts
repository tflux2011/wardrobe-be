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
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
    return result;
  }

  /**
   * Default templates seeded automatically into the database if missing
   */
  static getDefaultTemplates(): Record<string, { subject: string; body: string }> {
    return {
      welcome: {
        subject: 'Welcome to Clad Atelier // Closet Calibration Initiated',
        body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FDFBF7; color: #524E4A; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #060097; padding: 40px; }
    .header { font-size: 10px; font-weight: bold; color: #D25C34; letter-spacing: 0.15em; margin-bottom: 24px; text-transform: uppercase; }
    h1 { font-size: 24px; font-weight: 300; color: #060097; margin: 0 0 20px 0; letter-spacing: 0.02em; }
    p { font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .highlight-box { background-color: #F5F1E9; border: 1px solid #060097; padding: 24px; margin-bottom: 32px; }
    .highlight-box h2 { font-size: 11px; font-weight: bold; color: #060097; margin: 0 0 12px 0; letter-spacing: 0.08em; }
    .btn { display: inline-block; background-color: #060097; color: #FFFFFF !important; text-decoration: none; padding: 12px 24px; font-size: 10px; font-weight: bold; letter-spacing: 0.1em; border-radius: 0px; text-transform: uppercase; }
    .footer { font-size: 9px; color: #8F8C88; margin-top: 40px; border-top: 1px solid #E5E2DC; padding-top: 20px; letter-spacing: 0.05em; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">CLAD ATELIER // ONBOARDING Blueprints</div>
    <h1>Welcome, {{userName}}</h1>
    <p>Your closet calibration is now officially active. Clad Atelier maps your garments' silhouette profiles and structures to suggest tailored combinations that ensure maximum wear and curated styling harmony.</p>
    
    <div class="highlight-box">
      <h2>NEXT DIRECTIVES</h2>
      <p style="margin-bottom:0;">Start by adding 3 to 5 base items—tops, bottoms, and shoes—in the closet swapper to seed the curation engine and unlock OOTD recommendations.</p>
    </div>
    
    <a href="https://clad-atelier.com" class="btn">Enter Your Showroom</a>
    
    <div class="footer">
      ATELIER CORE INDEX // SECURE CONSOLE CONTROL
    </div>
  </div>
</body>
</html>`,
      },
      trip_digest: {
        subject: 'Atelier Travel Blueprint // Curation for {{destination}}',
        body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FDFBF7; color: #524E4A; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #060097; padding: 40px; }
    .header { font-size: 10px; font-weight: bold; color: #D25C34; letter-spacing: 0.15em; margin-bottom: 24px; text-transform: uppercase; }
    h1 { font-size: 24px; font-weight: 300; color: #060097; margin: 0 0 20px 0; letter-spacing: 0.02em; }
    p { font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .section-title { font-size: 12px; font-weight: bold; color: #060097; letter-spacing: 0.08em; border-bottom: 1.5px solid #060097; padding-bottom: 6px; margin: 32px 0 16px 0; text-transform: uppercase; }
    .table-list { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .table-list th { text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097; }
    .table-list td { padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; }
    .footer { font-size: 9px; color: #8F8C88; margin-top: 40px; border-top: 1px solid #E5E2DC; padding-top: 20px; letter-spacing: 0.05em; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">CLAD ATELIER // Travel Blueprint</div>
    <h1>Curation for {{destination}}</h1>
    <p>Your travel coordinates are ready. We have analyzed the weather, your travel parameters, and color contrast logic to build a high-performance minimalist packing list.</p>
    
    <div class="section-title">PACKING REGISTER</div>
    {{packingListHtml}}
    
    <div class="section-title">DAILY ITINERARY Blueprints</div>
    {{itineraryHtml}}
    
    <div class="footer">
      CLAD ATELIER TRAVEL DIVISION // SECURE SYNC
    </div>
  </div>
</body>
</html>`,
      },
      neglected_digest: {
        subject: 'Showroom Attention Needed // Neglected Garments',
        body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FDFBF7; color: #524E4A; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #060097; padding: 40px; }
    .header { font-size: 10px; font-weight: bold; color: #D25C34; letter-spacing: 0.15em; margin-bottom: 24px; text-transform: uppercase; }
    h1 { font-size: 24px; font-weight: 300; color: #060097; margin: 0 0 20px 0; letter-spacing: 0.02em; }
    p { font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .section-title { font-size: 12px; font-weight: bold; color: #060097; letter-spacing: 0.08em; border-bottom: 1.5px solid #060097; padding-bottom: 6px; margin: 32px 0 16px 0; text-transform: uppercase; }
    .footer { font-size: 9px; color: #8F8C88; margin-top: 40px; border-top: 1px solid #E5E2DC; padding-top: 20px; letter-spacing: 0.05em; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">CLAD ATELIER // NEGLECT ALERTS</div>
    <h1>Neglected Garments</h1>
    <p>Curation alert. Several essential garments inside your showroom haven't been worn in over 30 days. Let's re-integrate these key elements back into your styling cycle to optimize closet utility and unlock creative texture pairings.</p>
    
    <div class="section-title">GARMENT INDEX</div>
    {{neglectedItemsHtml}}
    
    <div class="footer">
      CLAD ATELIER CORE // AUTONOMOUS RETENTION CONTROL
    </div>
  </div>
</body>
</html>`,
      },
    };
  }
}


