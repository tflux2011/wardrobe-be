import express from 'express';
import { prisma } from '../lib/prisma';
import { ApiError } from '../utils/errors';
import crypto from 'crypto';
import { EmailService } from '../services/email_service';

export const adminRouter = express.Router();

// A simple in-memory session token mapping for admin
// In a real production app you'd use signed JWTs (jsonwebtoken)
// but for MVP this is perfectly fine and avoids extra dependencies
const adminSessions = new Set<string>();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware to verify admin token
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Admin authentication required');
  }
  const token = authHeader.split(' ')[1];
  if (!adminSessions.has(token)) {
    throw new ApiError(403, 'Invalid or expired admin token');
  }
  next();
}

adminRouter.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  // Use environment variables or fallback for testing
  const validUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const validPassword = process.env.ADMIN_PASSWORD ?? 'wardrobe2024';

  if (username === validUsername && password === validPassword) {
    const token = generateToken();
    adminSessions.add(token);
    res.json({ token });
  } else {
    throw new ApiError(401, 'Invalid admin credentials');
  }
});

adminRouter.get('/test-supabase', async (req, res) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  const diagnostics = {
    urlSet: !!supabaseUrl,
    urlLength: supabaseUrl ? supabaseUrl.length : 0,
    urlPreview: supabaseUrl ? `${supabaseUrl.substring(0, 15)}...${supabaseUrl.substring(supabaseUrl.length - 5)}` : 'none',
    keySet: !!supabaseServiceKey,
    keyLength: supabaseServiceKey ? supabaseServiceKey.length : 0,
    keyPreview: supabaseServiceKey ? `${supabaseServiceKey.substring(0, 10)}...${supabaseServiceKey.substring(supabaseServiceKey.length - 5)}` : 'none',
  };

  try {
    const { supabase } = await import('../lib/supabase');
    const dummyBuffer = Buffer.from('Supabase storage connection test');
    const filename = `test_connection_${Date.now()}.txt`;
    
    const { data, error } = await supabase.storage
      .from('wardrobe-images')
      .upload(filename, dummyBuffer, {
        contentType: 'text/plain',
        upsert: true,
      });

    if (error) {
      return res.json({
        status: 'failed',
        error: error.message,
        diagnostics
      });
    }

    const { data: publicUrlData } = supabase.storage
      .from('wardrobe-images')
      .getPublicUrl(data.path);

    // Clean up the dummy file
    await supabase.storage.from('wardrobe-images').remove([data.path]);

    return res.json({
      status: 'success',
      publicUrl: publicUrlData.publicUrl,
      diagnostics
    });
  } catch (err: any) {
    return res.json({
      status: 'error',
      message: err.message,
      stack: err.stack,
      diagnostics
    });
  }
});

adminRouter.use(requireAdmin);

adminRouter.get('/stats', async (req, res) => {
  const [usersCount, itemsCount, outfitsCount, tripsCount] = await Promise.all([
    prisma.user.count(),
    prisma.clothingItem.count(),
    prisma.outfit.count(),
    prisma.trip.count()
  ]);

  res.json({
    users: usersCount,
    items: itemsCount,
    outfits: outfitsCount,
    trips: tripsCount
  });
});

adminRouter.get('/whitelist', async (req, res) => {
  const emails = await prisma.whitelistedEmail.findMany({
    orderBy: { addedAt: 'desc' }
  });
  res.json(emails);
});

adminRouter.post('/whitelist', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    throw new ApiError(400, 'Valid email required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await prisma.whitelistedEmail.findUnique({
    where: { email: normalizedEmail }
  });

  if (existing) {
    throw new ApiError(400, 'Email is already whitelisted');
  }

  const added = await prisma.whitelistedEmail.create({
    data: { email: normalizedEmail }
  });

  res.json(added);
});

adminRouter.delete('/whitelist/:email', async (req, res) => {
  const { email } = req.params;
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    await prisma.whitelistedEmail.delete({
      where: { email: normalizedEmail }
    });
    res.json({ success: true });
  } catch (err) {
    throw new ApiError(404, 'Email not found in whitelist');
  }
});

// GET /api/admin/emails - Fetch all templates (with self-healing auto-seeding)
adminRouter.get('/emails', async (req, res) => {
  let templates = await prisma.emailTemplate.findMany({
    orderBy: { id: 'asc' }
  });

  if (templates.length === 0) {
    const defaults = EmailService.getDefaultTemplates();
    const seeded = [];
    for (const [id, t] of Object.entries(defaults)) {
      const entry = await prisma.emailTemplate.create({
        data: {
          id,
          subject: t.subject,
          body: t.body,
        }
      });
      seeded.push(entry);
    }
    return res.json(seeded);
  }

  res.json(templates);
});

// PUT /api/admin/emails/:id - Update dynamic template
adminRouter.put('/emails/:id', async (req, res) => {
  const { id } = req.params;
  const { subject, body } = req.body;

  if (!subject || typeof subject !== 'string' || !body || typeof body !== 'string') {
    throw new ApiError(400, 'Subject and body strings are required');
  }

  const updated = await prisma.emailTemplate.update({
    where: { id },
    data: { subject, body }
  });

  res.json(updated);
});

// POST /api/admin/emails/:id/test - Send test preview email
adminRouter.post('/emails/:id/test', async (req, res) => {
  const { id } = req.params;
  const { testEmail } = req.body;

  if (!testEmail || typeof testEmail !== 'string' || !testEmail.includes('@')) {
    throw new ApiError(400, 'Valid test email address is required');
  }

  const template = await prisma.emailTemplate.findUnique({
    where: { id }
  });

  if (!template) {
    throw new ApiError(404, `Template with ID '${id}' not found`);
  }

  // Render template using realistic mock details
  let renderedHtml = template.body;
  if (id === 'welcome') {
    renderedHtml = EmailService.interpolate(template.body, {
      userName: 'Alexander Patron',
    });
  } else if (id === 'trip_digest') {
    renderedHtml = EmailService.interpolate(template.body, {
      destination: 'Paris, France',
      packingListHtml: `
        <table class="table-list" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <thead>
            <tr>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Garment Name</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Category</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Style</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Camel Wool Double-Breasted Blazer</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Outerwear</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Smart</td>
            </tr>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Belgian Linen Camp Collar Shirt</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Top</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Casual</td>
            </tr>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">White Tommy Hilfiger Sneaker</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Shoes</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Casual</td>
            </tr>
          </tbody>
        </table>
      `,
      itineraryHtml: `
        <table class="table-list" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <thead>
            <tr>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Day / Date</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Curated Coordinate Blueprint</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Day 01 // May 28</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Beige quarter-zip polo shirt + Loose-fit denim jeans + Tommy Hilfiger sneakers</td>
            </tr>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Day 02 // May 29</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Sage green knit polo shirt + Olive green cargo pants + White Cole Haan sneakers</td>
            </tr>
          </tbody>
        </table>
      `,
    });
  } else if (id === 'neglected_digest') {
    renderedHtml = EmailService.interpolate(template.body, {
      neglectedItemsHtml: `
        <table class="table-list" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <thead>
            <tr>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Garment Name</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Last Worn Date</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Neglect Index</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Black Leather Chelsea Boots</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">2026-04-12</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; color:#D25C34; font-weight:bold;">45 DAYS UNWORN</td>
            </tr>
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">Teal Polo Shirt with Contrast Trim</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">2026-04-20</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; color:#D25C34; font-weight:bold;">37 DAYS UNWORN</td>
            </tr>
          </tbody>
        </table>
      `,
    });
  }

  // Send the test dispatch
  const result = await EmailService.sendEmail({
    to: testEmail,
    subject: `[TEST PREVIEW] ${template.subject}`,
    html: renderedHtml,
  });

  res.json({
    success: true,
    message: result.mode === 'live' 
      ? `Live preview successfully dispatched to ${testEmail}!`
      : `Test email successfully simulated to ${testEmail}!`,
    mode: result.mode,
    receiptId: result.id,
    subject: `[TEST PREVIEW] ${template.subject}`,
    html: renderedHtml,
  });
});
