import express from 'express';
import { prisma } from '../lib/prisma';
import { ApiError } from '../utils/errors';
import crypto from 'crypto';

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
