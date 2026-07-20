import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validateBody";
import { rechargeSchema } from "./schemas";
import { getBalanceHandler, getHistoryHandler, rechargeHandler } from "./controller";

export const walletRouter = Router();

walletRouter.use(requireAuth);

walletRouter.get("/me", getBalanceHandler);
walletRouter.post("/recharge", validateBody(rechargeSchema), rechargeHandler);
walletRouter.get("/transactions", getHistoryHandler);
