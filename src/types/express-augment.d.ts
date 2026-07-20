import { AccessTokenPayload } from "../modules/auth/tokens";

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export {};
