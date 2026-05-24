import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateTripPlan } from '../services/claude_service';

const router = Router();
const prisma = new PrismaClient();

// GET all trips for the authenticated user
router.get('/', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const trips = await prisma.trip.findMany({
      where: { userId: uid },
      orderBy: { startDate: 'asc' },
    });

    res.json(trips.map(t => ({
      ...t,
      packingList: JSON.parse(t.packingList),
      dailyOutfits: JSON.parse(t.dailyOutfits),
      suggestedAdditions: JSON.parse(t.suggestedAdditions || '[]'),
    })));
  } catch (error) {
    console.error('Error fetching trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// POST to create a new trip and generate itinerary
router.post('/plan', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { destination, startDate, endDate, purpose, styleProfile } = req.body;
    
    if (!destination || !startDate || !endDate || !purpose) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch user's wardrobe
    const wardrobe = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    if (wardrobe.length === 0) {
      return res.status(400).json({ error: 'Your closet is empty. Add clothes first.' });
    }

    const plan = await generateTripPlan({
      destination,
      startDate,
      endDate,
      purpose,
      wardrobe: wardrobe.map(i => ({
        id: i.id,
        name: i.name,
        category: i.category,
        colors: JSON.parse(i.colors),
        style: i.style,
        occasions: JSON.parse(i.occasions),
        seasons: JSON.parse(i.seasons),
        tags: JSON.parse(i.tags),
        lastWornAt: i.lastWornAt?.toISOString(),
      })),
      styleProfile,
    });

    const trip = await prisma.trip.create({
      data: {
        userId: uid,
        destination,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        purpose,
        packingList: JSON.stringify(plan.packingList),
        dailyOutfits: JSON.stringify(plan.dailyOutfits),
        suggestedAdditions: JSON.stringify(plan.suggestedAdditions || []),
      },
    });

    res.json({
      ...trip,
      packingList: plan.packingList,
      dailyOutfits: plan.dailyOutfits,
      suggestedAdditions: plan.suggestedAdditions || [],
    });

  } catch (error) {
    console.error('Error planning trip:', error);
    res.status(500).json({ error: 'Failed to generate trip plan' });
  }
});

// DELETE a trip
router.delete('/:id', async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { id } = req.params;
    
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await prisma.trip.delete({
      where: { id, userId: uid },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting trip:', error);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

export default router;
