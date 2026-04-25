import { offerRepository } from '../firestore';
import type { Offer } from '../types';

export const offerService = {
  fetch(offer_id: string): Promise<Offer | null> {
    return offerRepository.getById(offer_id);
  },
};
