// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
//
// One strategy program, run by the grader as `node /bot/main.ts`.
// The strategy lives in strategy.ts; this file only wires it to the wire
// shim in vendor/makefun-bot.ts, which speaks agent-fun/replay/v2 on stdin
// and stdout. The bot reads the hello message for its capital, caps and
// fees, answers every batch with the orders decided on that slot, and stops
// at done. No network, no secrets, no clock, no randomness: the same window
// always produces the same action log.
//
// Final tuned parameters (DEFAULT_PARAMS in strategy.ts): very selective
// entry, at least 100 SOL of early buy volume and a price between 1.2x and
// 2x of creation, within the first 1500 slots. Dev window: net PnL -0.026
// SOL over 30 round trips, max drawdown 0.71%, guardrails met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
