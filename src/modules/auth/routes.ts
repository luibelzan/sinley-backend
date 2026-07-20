import { Router } from "express";
import { validateBody } from "../../middleware/validateBody";
import { loginSchema, refreshSchema, registerSchema } from "./schemas";
import { loginHandler, logoutHandler, refreshHandler, registerHandler } from "./controller";

export const authRouter = Router();

authRouter.post("/register", validateBody(registerSchema), registerHandler);
authRouter.post("/login", validateBody(loginSchema), loginHandler);
authRouter.post("/refresh", validateBody(refreshSchema), refreshHandler);
authRouter.post("/logout", validateBody(refreshSchema), logoutHandler);
