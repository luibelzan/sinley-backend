import { RequestHandler } from "express";
import * as walletService from "./service";
import { AppError } from "../../utils/AppError";

export const getBalanceHandler: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const wallet = await walletService.getBalance(userId);
    res.json(wallet);
  } catch (err) {
    next(err);
  }
};

export const rechargeHandler: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const wallet = await walletService.recharge(userId, req.body.amount);
    res.status(201).json(wallet);
  } catch (err) {
    if (walletService.isInsufficientFundsError(err)) {
      next(new AppError(409, "insufficient_funds", "Saldo insuficiente para esta operación"));
      return;
    }
    next(err);
  }
};

export const getHistoryHandler: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const history = await walletService.getHistory(userId);
    res.json({ transactions: history });
  } catch (err) {
    next(err);
  }
};
