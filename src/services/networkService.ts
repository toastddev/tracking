import { networkRepository } from '../firestore';
import type { Network } from '../types';

export const networkService = {
  fetch(network_id: string): Promise<Network | null> {
    return networkRepository.getById(network_id);
  },
};
