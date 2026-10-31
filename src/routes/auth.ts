import { Router } from 'express';
import type { AppConfig } from '../types.ts';
import {
  createLoginHandler,
  createLogoutHandler,
  createSessionStatusHandler,
} from '../middleware/auth.ts';

export function createAuthRoutes(config: AppConfig): Router {
  const router = Router();
  router.post('/login', createLoginHandler(config));
  router.post('/logout', createLogoutHandler(config));
  router.get('/session', createSessionStatusHandler(config));
  return router;
}
