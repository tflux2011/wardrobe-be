import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

export const userRouter = Router();

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
