import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { EmailService } from '../services/email_service';
import { firebaseAuth } from '../config/firebase_admin';

export const userRouter = Router();

// POST /api/user/forgot-password
// Generates a custom recovery token and dispatches a Sand Linen branded HTML email
userRouter.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Valid email coordinates are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    // 1. Verify user exists in the local registry
    const user = await prisma.user.findFirst({
      where: { email: cleanEmail }
    });

    if (!user) {
      // Return a 200 silent success to prevent email coordinates enumeration
      return res.json({ message: 'If the coordinates exist in our registry, a recovery link will be sent.' });
    }

    // 2. Generate secure high-entropy token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 3600000); // 1 hour lifetime

    // 3. Save to database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: token,
        resetTokenExpires: tokenExpires
      }
    });

    // 4. Construct reset landing page link
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    // 5. Send sand-linen styled email
    const subject = 'Atelier Security Coordinate // Password Reset Link';
    const html = `<!DOCTYPE html>
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
    <div class="header">CLAD ATELIER // ACCOUNT RECOVERY</div>
    <h1>Reset Your Password</h1>
    <p>We received a request to reset the password associated with your digital showroom coordinates. Click the link below to establish a new password and resume closet calibration.</p>
    
    <div class="highlight-box">
      <h2>SECURITY DIRECTIVE</h2>
      <p style="margin-bottom:0; font-size:13px; line-height:1.5;">This password reset coordinate link is only valid for <strong>1 hour</strong>. If you did not initiate this request, you can safely ignore this email; your showroom credentials remain secure.</p>
    </div>
    
    <a href="${resetUrl}" class="btn" style="color: #FFFFFF !important;">Reset Password</a>
    
    <div class="footer">
      ATELIER SECURITY LEDGER // AUTONOMOUS SECURITY SYNC
    </div>
  </div>
</body>
</html>`;

    await EmailService.sendEmail({ to: cleanEmail, subject, html });

    return res.json({ message: 'If the coordinates exist in our registry, a recovery link will be sent.' });
  } catch (error) {
    console.error('[forgot-password]', error);
    return res.status(500).json({ error: 'Failed to process forgot password request.' });
  }
});

// POST /api/user/reset-password
// Verifies custom recovery token and updates credentials inside Firebase Authentication
userRouter.post('/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Verification token coordinate is required.' });
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }

  if (!firebaseAuth) {
    console.error('[reset-password] Firebase Admin is NOT initialized. Reset password operation aborted.');
    return res.status(500).json({ error: 'Custom password reset is temporarily unavailable (Firebase Admin key missing).' });
  }

  try {
    // 1. Validate token and check expiration
    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpires: {
          gt: new Date()
        }
      }
    });

    if (!user) {
      return res.status(400).json({ error: 'Verification token is invalid, expired, or has already been used.' });
    }

    // 2. Synchronize credentials directly inside Firebase Auth
    await firebaseAuth.updateUser(user.id, {
      password: newPassword
    });

    // 3. Wipes active token parameters
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: null,
        resetTokenExpires: null
      }
    });

    return res.json({ message: 'Showroom credentials updated successfully. Please return to Clad Atelier app.' });
  } catch (error) {
    console.error('[reset-password]', error);
    return res.status(500).json({ error: 'Failed to synchronize password update with Firebase Auth.' });
  }
});

userRouter.use(requireAuth);

// POST /api/user/profile
// Creates or updates the user profile with full name and gender
userRouter.post('/profile', async (req: Request, res: Response) => {
  const uid = (req as any).user?.uid;
  const email = (req as any).user?.email?.toLowerCase().trim();
  const { fullName, gender } = req.body;

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await prisma.user.upsert({
      where: { id: uid },
      update: {
        fullName: fullName || undefined,
        gender: gender || undefined,
        email: email || undefined,
      },
      create: {
        id: uid,
        email: email || null,
        fullName: fullName || null,
        gender: gender || null,
      },
    });

    return res.json(user);
  } catch (error) {
    console.error('[user/profile]', error);
    return res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// GET /api/user/profile
// Fetches the user profile details including full name and gender
userRouter.get('/profile', async (req: Request, res: Response) => {
  const uid = (req as any).user?.uid;

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        id: true,
        email: true,
        fullName: true,
        gender: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.json(user);
  } catch (error) {
    console.error('[user/get-profile]', error);
    return res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// GET /api/user/status
// Checks if the authenticated user's email is in the whitelist.
userRouter.get('/status', async (req: Request, res: Response) => {
  const email = (req as any).user?.email?.toLowerCase().trim();
  
  if (!email) {
    return res.json({ isWhitelisted: false });
  }

  const whitelisted = await prisma.whitelistedEmail.findUnique({
    where: { email }
  });

  return res.json({ isWhitelisted: !!whitelisted });
});

// DELETE /api/user
// Permanently deletes the user and all associated data from the database.
userRouter.delete('/', async (req: Request, res: Response) => {
  const uid = (req as any).user?.uid;
  
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Optional: Delete user images from Supabase Storage if you want to be thorough.
    // However, tracking all individual image paths requires fetching them first.
    // For V1 MVP, database deletion with cascade is sufficient.
    
    // Deleting the user will cascade and delete all associated records 
    // (ClothingItem, Outfit, Trip) due to onDelete: Cascade in prisma schema.
    await prisma.user.delete({
      where: { id: uid },
    });

    return res.json({ message: 'User data successfully deleted' });
  } catch (error) {
    console.error('[user/delete]', error);
    // If the user doesn't exist in Prisma, it might throw a record not found error,
    // which is fine, we still want to return a successful response so the frontend can proceed.
    if ((error as any).code === 'P2025') {
      return res.json({ message: 'User data already deleted or not found' });
    }
    return res.status(500).json({ error: 'Failed to delete user data' });
  }
});
