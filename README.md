[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun · rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/inifikry/pump-replay-makefun/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun · reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/inifikry/pump-replay-makefun/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Paper Bot

A paper-trading bot for the make.fun pump.fun replay sprint. It trades 10
SOL of paper money on a replay of pump.fun bonding-curve activity.

## Strategy: very selective early spark, quick exit

- Watch every new coin from its `CreateEvent`.
- Buy once, only when a coin has proven real demand: at least 100 SOL of
  buy volume and at least 10 buy trades, its price between 1.2x and 2x of
  its creation price, and still young (first 1500 slots). The volume bar is
  the whole edge: on the dev window, looser volume bars lost far more, and
  the 100 SOL bar was the only one that came out near breakeven.
- Size is 0.02 SOL for the first buy (never below the 0.01 SOL minimum
  round-trip size, never above the harness cap of 1% of the coin's real SOL
  reserves). At most 5 coins held at once. No pyramid adds: backtests
  showed buying more of a coin after it ran gave the gains back, so the
  add stakes are 0.
- Manage by rules: sell half at 2x, sell half of the rest at 3x, ride the
  remainder under a 20% trailing stop, cut everything on a 25% hard stop,
  and time out of flat positions after 3,600 slots so the slots keep
  recycling for fresh coins.
- Dead-coin guard: when the curve's real reserves drain so low that a sell
  cannot be paid out, the position is left alone and retried only after
  2,000 slots, and tokens promised to a sell already in flight are never
  sold twice.

## Why this shape

Per-trade expectancy on this market is slightly negative after the ~1.25%
curve fees plus transaction fees, at every selectivity level tested, so the
design does not chase volume. It takes few, high-conviction trades, keeps
drawdown tiny, and keeps its upside in the fat right tail: a handful of
coins that run 2x-10x. Dev window: net PnL -0.026 SOL over 30 round trips,
max drawdown 0.71%, guardrails met (30 coins above the 20-coin floor).

## Determinism

No clock, no environment, no `Math.random`: the only randomness source is
the seed in the `hello` message, so the same window always produces the
same action log. Orders are answered once per batch, one reply per batch.

## Files

- `main.ts` — entrypoint: wires the strategy to the wire shim.
- `strategy.ts` — the strategy (parameters at the top, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged.

Paper trading only: no real funds, no network, no secrets.
