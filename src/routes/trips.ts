import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { generateTripPlan } from '../services/claude_service';
import { EmailService } from '../services/email_service';

const router = Router();

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

    const { destination, startDate, endDate, purpose, homeCity, styleProfile } = req.body;
    
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
      homeCity,
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

    // Helper functions to render email tables matching flat solid Luxury Brand styling
    const buildPackingListHtml = (packingItemIds: string[], wardrobeItems: any[]) => {
      let rowsHtml = '';
      for (const itemId of packingItemIds) {
        const item = wardrobeItems.find(w => w.id === itemId);
        if (item) {
          const colors = JSON.parse(item.colors).join(', ');
          rowsHtml += `
            <tr>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; font-weight: 600;">${item.name}</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; text-transform: uppercase;">${item.category}</td>
              <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; font-style: italic;">${colors} // ${item.style}</td>
            </tr>
          `;
        }
      }
      return `
        <table class="table-list" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <thead>
            <tr>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Garment Name</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Category</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Details</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="3" style="padding: 10px 8px; font-size: 13px; text-align: center; color: #8F8C88;">No items added to packing list</td></tr>'}
          </tbody>
        </table>
      `;
    };

    const buildItineraryHtml = (dailyOutfits: any[], wardrobeItems: any[]) => {
      let rowsHtml = '';
      for (const dayInfo of dailyOutfits) {
        const day = dayInfo.day;
        const outfit = dayInfo.outfit;
        const itemNames = outfit.itemIds
          .map((itemId: string) => wardrobeItems.find(w => w.id === itemId)?.name)
          .filter(Boolean)
          .join(' + ');

        rowsHtml += `
          <tr>
            <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC; font-weight: bold;">Day ${day} // ${outfit.name || 'Outfit'}</td>
            <td style="padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #E5E2DC;">
              <div style="font-weight: 600; margin-bottom: 4px; color: #060097;">${itemNames}</div>
              <div style="font-size: 11px; color: #524E4A; line-height: 1.4;">${outfit.rationale}</div>
            </td>
          </tr>
        `;
      }
      return `
        <table class="table-list" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <thead>
            <tr>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Day & Coordinate</th>
              <th style="text-align: left; font-size: 9px; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px; background-color: #F5F1E9; border-bottom: 1px solid #060097;">Styling Blueprint</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="2" style="padding: 10px 8px; font-size: 13px; text-align: center; color: #8F8C88;">No daily plans generated</td></tr>'}
          </tbody>
        </table>
      `;
    };

    // Dispatch the trip digest email in the background
    if (req.user?.email) {
      const email = req.user.email;
      prisma.emailTemplate.findUnique({
        where: { id: 'trip_digest' }
      }).then(async (tripTemplate) => {
        const subjectTemplate = tripTemplate?.subject || 'Atelier Travel Blueprint // Curation for {{destination}}';
        const bodyTemplate = tripTemplate?.body || EmailService.getDefaultTemplates().trip_digest.body;
        
        const subject = EmailService.interpolate(subjectTemplate, { destination });
        const renderedHtml = EmailService.interpolate(bodyTemplate, {
          destination,
          packingListHtml: buildPackingListHtml(plan.packingList, wardrobe),
          itineraryHtml: buildItineraryHtml(plan.dailyOutfits, wardrobe),
        });

        const res = await EmailService.sendEmail({
          to: email,
          subject,
          html: renderedHtml
        });
        console.log(`[Trip Digest Email] Sent to ${email} (Mode: ${res.mode}, ID: ${res.id})`);
      }).catch(err => {
        console.error('[Trip Digest Email] Failed to send trip digest:', err);
      });
    }

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
