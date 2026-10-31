import { Router, type Request, type Response } from 'express';
import type { Queue } from '../services/queue.ts';

export function createQueueRoutes(queue: Queue, callsEnabled = true): Router {
  const router = Router();

  router.post('/start', (_req: Request, res: Response) => {
    if (!callsEnabled) {
      res.status(403).json({ running: false, error: 'Calls are disabled in local mode' });
      return;
    }
    queue.start();
    res.json({ running: queue.running });
  });

  router.post('/pause', (_req: Request, res: Response) => {
    queue.pause();
    res.json({ running: queue.running });
  });

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ running: queue.running });
  });

  return router;
}
