import { Router } from 'express';
import { dayChange,packingAfterDayChange } from '../services/trip_editing';
import { prisma } from '../lib/prisma';
import { generateTripPlan,pairWardrobeIdea } from '../services/claude_service';
import { EmailService } from '../services/email_service';
import { travelDetailsSchema, tripRequestSchema, tripDateRange, validateTripPlan } from '../services/trip_validation';

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

    const parsed = tripRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Add a destination, travel dates, and plans for your trip.' });
    const { destination, purpose, homeCity, styleProfile } = parsed.data;
    let dates;
    try { dates = tripDateRange(parsed.data.startDate, parsed.data.endDate); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    const startDate = dates.startDate.toISOString(), endDate = dates.endDate.toISOString();

    // Fetch user's wardrobe
    const wardrobe = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    if (wardrobe.length === 0) {
      return res.status(400).json({ error: 'Your closet is empty. Add clothes first.' });
    }

    const generated = await generateTripPlan({
      destination,
      startDate,
      endDate,
      purpose: parsed.data.travelDetails ? `${purpose}. Transport: ${parsed.data.travelDetails.transport}. Luggage: ${parsed.data.travelDetails.luggage.join(', ') || 'Suggest a compact packing list'}. Reuse pieces across days to keep the packing list practical for these bags. Target no more than ${parsed.data.travelDetails.maxPieces??20} unique pieces.` : purpose,
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

    const plan = validateTripPlan(generated, wardrobe.map(item => item.id), dates.days,parsed.data.travelDetails?.maxPieces);

    if(parsed.data.travelDetails && plan.dailyOutfits.length) (plan.dailyOutfits[0] as any).travelDetails=parsed.data.travelDetails;
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
    if(error instanceof Error && error.message.includes('packing target'))return res.status(422).json({error:error.message});
    console.error('Error planning trip:', error);
    res.status(500).json({ error: 'Failed to generate trip plan' });
  }
});

router.post('/:id/ideas/:index/pairings',async(req,res)=>{
 try{
  const uid=req.user?.uid;if(!uid)return res.status(401).json({error:'Unauthorized'});
  const index=Number(req.params.index);if(!Number.isInteger(index)||index<0)return res.status(400).json({error:'Choose a valid idea.'});
  const trip=await prisma.trip.findFirst({where:{id:req.params.id,userId:uid}});if(!trip)return res.status(404).json({error:'Trip not found.'});
  const ideas=JSON.parse(trip.suggestedAdditions||'[]');if(index>=ideas.length)return res.status(404).json({error:'Idea not found.'});
  const wardrobe=await prisma.clothingItem.findMany({where:{userId:uid}});
  if(!wardrobe.length)return res.status(400).json({error:'Add clothing to your closet first.'});
  const pairing=await pairWardrobeIdea(ideas[index],wardrobe.map(i=>({id:i.id,name:i.name,category:i.category,colors:JSON.parse(i.colors),style:i.style})),req.body?.styleProfile);
  const owned=new Set(wardrobe.map(i=>i.id));
  if(!Array.isArray(pairing.pairWithItemIds)||!pairing.pairWithItemIds.length||pairing.pairWithItemIds.some(id=>!owned.has(id))||typeof pairing.reason!=='string')return res.status(502).json({error:'Could not match this idea to saved pieces. Try again.'});
  ideas[index]={...ideas[index],pairWithItemIds:[...new Set(pairing.pairWithItemIds)].slice(0,3),reason:pairing.reason.slice(0,800)};
  const changed=await prisma.trip.updateMany({where:{id:trip.id,userId:uid,suggestedAdditions:trip.suggestedAdditions},data:{suggestedAdditions:JSON.stringify(ideas)}});
  if(!changed.count)return res.status(409).json({error:'The trip changed. Reopen it and try again.'});
  const saved=await prisma.trip.findUniqueOrThrow({where:{id:trip.id}});
  return res.json({...saved,dailyOutfits:JSON.parse(saved.dailyOutfits),packingList:JSON.parse(saved.packingList),suggestedAdditions:ideas});
 }catch{return res.status(500).json({error:'Could not create a wardrobe pairing. Please try again.'});}
});

router.patch('/:id/travel',async(req,res)=>{
  try{
    const uid=req.user?.uid;if(!uid)return res.status(401).json({error:'Unauthorized'});
    const parsed=travelDetailsSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Choose valid luggage and transport details.'});
    const trip=await prisma.trip.findFirst({where:{id:req.params.id,userId:uid}});if(!trip)return res.status(404).json({error:'Trip not found.'});
    const days=JSON.parse(trip.dailyOutfits);if(!days.length)return res.status(400).json({error:'This trip has no saved itinerary.'});
    days[0]={...days[0],travelDetails:parsed.data};
    const result=await prisma.trip.updateMany({where:{id:trip.id,userId:uid,dailyOutfits:trip.dailyOutfits},data:{dailyOutfits:JSON.stringify(days)}});
    if(!result.count)return res.status(409).json({error:'This trip changed elsewhere. Refresh it and try again.'});
    return res.json({...trip,dailyOutfits:days,packingList:JSON.parse(trip.packingList),suggestedAdditions:JSON.parse(trip.suggestedAdditions||'[]')});
  }catch{return res.status(500).json({error:'Could not save travel details.'});}
});

// Change one day without regenerating the rest of the journey or sending a digest.
router.patch('/:id/days/:index', async (req,res) => {
  try {
    const uid=req.user?.uid;
    if(!uid)return res.status(401).json({error:'Unauthorized'});
    const parsed=dayChange.safeParse(req.body),index=Number(req.params.index);
    if(!parsed.success || !Number.isInteger(index) || index<0)return res.status(400).json({error:'Choose a valid day and pieces.'});
    const trip=await prisma.trip.findFirst({where:{id:req.params.id,userId:uid}});
    if(!trip)return res.status(404).json({error:'Trip not found.'});
    const days=JSON.parse(trip.dailyOutfits);
    if(index>=days.length)return res.status(400).json({error:'Day not found.'});
    const wardrobe=await prisma.clothingItem.findMany({where:{userId:uid}});
    const owned=new Set(wardrobe.map(i=>i.id));
    if(parsed.data.itemIds?.some(id=>!owned.has(id)))return res.status(400).json({error:'Choose pieces from your current closet.'});
    const previous=days[index].outfit ?? days[index];
    let outfit={...previous};
    if(parsed.data.itemIds){
      outfit={...outfit,itemIds:[...new Set(parsed.data.itemIds)],rationale:'Selected by you from your wardrobe.'};
      delete outfit.perfume;
    } else {
      const date=new Date(trip.startDate);date.setUTCDate(date.getUTCDate()+index);
      const generated=await generateTripPlan({destination:trip.destination,startDate:date.toISOString(),endDate:date.toISOString(),purpose:`${parsed.data.occasion}. This is one day of a trip for ${trip.purpose}. Transport and luggage: ${JSON.stringify(days[0]?.travelDetails??{})}. Prefer pieces already packed: ${trip.packingList}.`,styleProfile:parsed.data.styleProfile,wardrobe:wardrobe.map(i=>({...i,colors:JSON.parse(i.colors),occasions:JSON.parse(i.occasions),seasons:JSON.parse(i.seasons),tags:JSON.parse(i.tags)}))});
      outfit=validateTripPlan(generated,wardrobe.map(i=>i.id),1).dailyOutfits[0].outfit;
    }
    if(parsed.data.occasion)outfit.occasion=parsed.data.occasion;
    const previousDays=JSON.parse(trip.dailyOutfits);
    days[index]={...days[index],outfit};
    const packing=packingAfterDayChange(previousDays,days,JSON.parse(trip.packingList));
    const changed=await prisma.trip.updateMany({where:{id:trip.id,userId:uid,dailyOutfits:trip.dailyOutfits},data:{dailyOutfits:JSON.stringify(days),packingList:JSON.stringify(packing)}});
    if(!changed.count)return res.status(409).json({error:'This trip changed elsewhere. Refresh it and try again.'});
    return res.json({...trip,dailyOutfits:days,packingList:packing,suggestedAdditions:JSON.parse(trip.suggestedAdditions||'[]')});
  } catch(error){console.error('Day update failed:',error);return res.status(500).json({error:'Could not update this day. Your previous plan is unchanged.'});}
});

// DELETE a trip
router.delete('/:id', async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { id } = req.params;
    
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await prisma.trip.deleteMany({
      where: { id, userId: uid },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting trip:', error);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

export default router;
