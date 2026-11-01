import { protectCredentials } from '../middleware/abuse';
import { usageSummary } from '../services/usage';
import { removePrivatePhotos } from '../services/media';
import { z } from 'zod';
import { appUrl, passwordResetEmail } from '../services/email_templates';
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
userRouter.post('/forgot-password', protectCredentials, async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || email.length>320) {
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
        resetToken: crypto.createHash('sha256').update(token).digest('hex'),
        resetTokenExpires: tokenExpires
      }
    });

    // 4. Construct reset landing page link
    const frontendUrl = appUrl();
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    // 5. Send sand-linen styled email
    const {subject, html} = passwordResetEmail(resetUrl);

    await EmailService.sendEmail({ to: cleanEmail, subject, html });

    return res.json({ message: 'If the coordinates exist in our registry, a recovery link will be sent.' });
  } catch (error) {
    console.error('[forgot-password]', error);
    return res.status(500).json({ error: 'Failed to process forgot password request.' });
  }
});

// POST /api/user/reset-password
// Verifies custom recovery token and updates credentials inside Firebase Authentication
userRouter.post('/reset-password', protectCredentials, async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Verification token coordinate is required.' });
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'New password must be between 8 and 128 characters long.' });
  }

  if (!firebaseAuth) {
    console.error('[reset-password] Firebase Admin is NOT initialized. Reset password operation aborted.');
    return res.status(500).json({ error: 'Custom password reset is temporarily unavailable (Firebase Admin key missing).' });
  }

  try {
    // 1. Validate token and check expiration
    const user = await prisma.user.findFirst({
      where: {
        resetToken: crypto.createHash('sha256').update(token).digest('hex'),
        resetTokenExpires: {
          gt: new Date()
        }
      }
    });

    if (!user) {
      return res.status(400).json({ error: 'Verification token is invalid, expired, or has already been used.' });
    }

    const consumed=await prisma.user.updateMany({where:{id:user.id,resetToken:user.resetToken,resetTokenExpires:{gt:new Date()}},data:{resetToken:null,resetTokenExpires:null}});
    if(consumed.count!==1)return res.status(400).json({error:'This reset link has already been used.'});
    // 2. Synchronize credentials directly inside Firebase Auth
    await firebaseAuth.updateUser(user.id, {
      password: newPassword
    });

    await firebaseAuth.revokeRefreshTokens(user.id);
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
userRouter.get('/usage',async(req,res)=>res.json(await usageSummary(req.user!.uid)));

// POST /api/user/profile
// Creates or updates the user profile with full name and gender
userRouter.post('/profile', async (req: Request, res: Response) => {
  const uid = (req as any).user?.uid;
  const email = (req as any).user?.email?.toLowerCase().trim();
  const parsed=z.object({fullName:z.string().trim().max(120).optional(),gender:z.enum(['Male','Female','Non-binary','Other','male','female','non-binary','other']).optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Check your profile details.'});
  const { fullName, gender } = parsed.data;

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

    return res.json({ id: user.id, email: user.email, fullName: user.fullName, gender: user.gender });
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
    const assets=await prisma.mediaAsset.findMany({where:{userId:uid},select:{id:true}});
    await removePrivatePhotos(uid,assets.map(a=>a.id));
    if(firebaseAuth)await firebaseAuth.deleteUser(uid).catch(error=>{if(error?.code!=='auth/user-not-found')throw error;});
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
