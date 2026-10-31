import { validateTripPlan } from './trip_validation';

export class TripGenerationError extends Error {}

/** Retry an invalid AI plan before any database write. Never accept unknown clothes. */
export async function generateValidatedTrip(
  generate: (repair: boolean) => Promise<unknown>,
  ownedIds: string[], days: number, maxPieces?: number,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await generate(attempt > 0);
    try { return validateTripPlan(generated, ownedIds, days, maxPieces); }
    catch (error) {
      if (attempt === 1) throw new TripGenerationError(
        error instanceof Error && error.message.includes('packing target')
          ? error.message
          : 'We could not put together a complete plan using your saved clothes. Your trip has not been saved. Please try again.');
    }
  }
  throw new TripGenerationError('Please try planning your trip again.');
}

/** Short references reduce ID transcription errors; unknown references remain invalid. */
export function tripWardrobeReferences<T extends {id: string}>(wardrobe: T[]) {
  const ids = new Map(wardrobe.map((item, i) => [`piece_${i + 1}`, item.id]));
  return {
    wardrobe: wardrobe.map((item, i) => ({...item, id: `piece_${i + 1}`})),
    restore(value: any): any {
      const restoreIds = (list: unknown) => Array.isArray(list)
        ? list.map(id => typeof id === 'string' ? ids.get(id) ?? id : id) : list;
      if (!value || typeof value !== 'object') return value;
      return {...value, packingList: restoreIds(value.packingList),
        dailyOutfits: Array.isArray(value.dailyOutfits) ? value.dailyOutfits.map((day: any) => ({...day,
          outfit: {...day.outfit, itemIds: restoreIds(day.outfit?.itemIds)}})) : value.dailyOutfits,
        suggestedAdditions: Array.isArray(value.suggestedAdditions) ? value.suggestedAdditions.map((idea: any) => ({...idea,
          pairWithItemIds: restoreIds(idea.pairWithItemIds)})) : value.suggestedAdditions};
    }
  };
}
