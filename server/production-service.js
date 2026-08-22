import { AdminMattMineService } from './admin-service.js';

// Production now uses the same server-authoritative gameplay service as every
// other runtime; the retired browser-currency layer no longer exists.
export class ProductionMattMineService extends AdminMattMineService {}
