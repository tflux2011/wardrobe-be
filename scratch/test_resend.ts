import dotenv from 'dotenv';
import path from 'path';
// Load env
dotenv.config({ path: path.join(__dirname, '../.env') });

import axios from 'axios';

async function diagnose() {
  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.RESEND_SENDER_EMAIL || 'onboarding@resend.dev';

  console.log('--- Resend Diagnostic Tool ---');
  console.log('API Key present:', !!apiKey);
  console.log('API Key length:', apiKey ? apiKey.length : 0);
  console.log('Sender Email:', sender);
  
  if (!apiKey) {
    console.error('ERROR: RESEND_API_KEY is not defined in .env');
    return;
  }

  try {
    console.log('\nSending test request to Resend API...');
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: `Clad Atelier <${sender}>`,
        to: 'tflux2011@gmail.com',
        subject: '[DIAGNOSTIC TEST] Resend Integration Check',
        html: '<p>If you see this, your Resend API credentials and domain verification are active!</p>',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    console.log('\nSUCCESS! Resend API returned status:', response.status);
    console.log('Response data:', response.data);
  } catch (err: any) {
    console.error('\nERROR: Request failed!');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Details:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Message:', err.message);
    }
  }
}

diagnose();
