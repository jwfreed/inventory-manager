import { expireReservationsJob } from '../services/orderToCash.service';

export async function runReservationExpiry() {
  await expireReservationsJob();
}

