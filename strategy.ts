// Pump.fun Replay Sprint — Paper Bot, Real Ranking
//
// Strategy: "early spark, quick exit". Watch every new bonding curve from its
// CreateEvent. A coin earns one buy as soon as the harness size cap lets the
// bot buy a meaningful amount (the cap is 1% of the coin's real SOL reserves,
// so the cap opening means real buyers have already put SOL in) while the
// coin is still young and its price has not run away. The buy is sized by the
// cap, up to a small stake, so early entries are small and the five open
// slots keep recycling into fresh coins. After entry the position is managed
// by rules, not hope: sell half into a double, sell half of what is left into
// a triple, ride the rest under a trailing stop, cut the whole position on a
// hard stop, and time out of flat positions so the slots keep turning over.
// A position that proves itself earns pyramid adds: buy more only as the
// price climbs and the size cap grows with it, so capital concentrates in
// the coins that run while losers stay small.
// No clock, no randomness, no network: every decision comes from the hello
// and batch messages the harness sends, so two runs of the same window agree
// byte for byte.
//
// The capital is split across slots: at most five coins are held at once, and
// the orders decided on one slot are batched into a single reply. A coin is
// decided once; a coin whose cap never opens is never bought.

import type { Batch, BotState, BuyInput, SellInput } from './vendor/makefun-bot.ts';

export interface Params {
  /** Target SOL per entry (lamports). The buy is capped by the harness size cap. */
  stakeLamports: bigint;
  /** Smallest buy worth sending (lamports). Also the guardrail round-trip floor. */
  minBuyLamports: bigint;
  /** Entry needs price >= this many bps of the creation price (10000 = at creation). */
  entryMultBps: number;
  /** Entry needs price <= this many bps of the creation price (no chasing tops). */
  maxEntryMultBps: number;
  /** Entry needs this much buy volume since creation (lamports; 0 = no filter). */
  minBuyVolLamports: bigint;
  /** Entry needs at least this many buy trades since creation (0 = no filter). */
  minBuyTrades: number;
  /** Entry only while the coin is at most this many slots old. */
  maxEntryAgeSlots: number;
  /** First take-profit multiple in bps (20000 = 2x): sell half the tokens. */
  takeProfit1Bps: number;
  /** Second take-profit multiple in bps (30000 = 3x): sell half of what is left. */
  takeProfit2Bps: number;
  /** Trailing stop in bps below the peak since entry (2000 = 20%): sell all. */
  trailBps: number;
  /** Hard stop in bps below the entry price (2500 = 25%): sell all. */
  stopBps: number;
  /** Time stop: exit when this many slots pass after entry... */
  timeStopSlots: number;
  /** ...and the price is still below this multiple of the entry price. */
  timeStopMultBps: number;
  /** Max slippage allowed on a buy (bps). */
  buySlippageBps: number;
  /** Max slippage allowed on a sell (bps). */
  sellSlippageBps: number;
  /** Second buy: when the price reaches this multiple of the entry price... */
  add2MultBps: number;
  /** ...and the size cap is at least this big, add up to this much (lamports). */
  add2CapLamports: bigint;
  add2StakeLamports: bigint;
  /** Third buy: same, at a higher multiple with a bigger cap and stake. */
  add3MultBps: number;
  add3CapLamports: bigint;
  add3StakeLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 20_000_000n,
  minBuyLamports: 10_000_000n,
  entryMultBps: 12_000,
  maxEntryMultBps: 20_000,
  minBuyVolLamports: 100_000_000_000n,
  minBuyTrades: 10,
  maxEntryAgeSlots: 1500,
  takeProfit1Bps: 20_000,
  takeProfit2Bps: 30_000,
  trailBps: 2_000,
  stopBps: 2_500,
  timeStopSlots: 3_600,
  timeStopMultBps: 12_500,
  buySlippageBps: 500,
  sellSlippageBps: 1_000,
  add2MultBps: 15_000,
  add2CapLamports: 50_000_000n,
  add2StakeLamports: 0n,
  add3MultBps: 25_000,
  add3CapLamports: 150_000_000n,
  add3StakeLamports: 0n,
};

const BPS = 10_000n;

/** A coin seen since its creation, tracked until it is decided or ages out. */
interface Watched {
  mint: string;
  createdSlot: number;
  createVq: bigint;
  createVt: bigint;
  buyVol: bigint;
  buyTrades: number;
  decided: boolean;
  complete: boolean;
  lastVq: bigint;
  lastVt: bigint;
}

/** A position under management: entry price from the filled cost basis. */
interface Managed {
  mint: string;
  entrySlot: number;
  /** Highest price (vq/vt) seen since entry. */
  peakVq: bigint;
  peakVt: bigint;
  tp1Done: boolean;
  tp2Done: boolean;
  /** Pyramid adds taken so far (0, 1 or 2). */
  adds: number;
}

/** priceA (vqA/vtA) >= priceB (vqB/vtB) * multBps / 10000, in integer math. */
function atLeastMult(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint, multBps: number): boolean {
  return vqA * vtB * BPS >= vqB * vtA * BigInt(multBps);
}

/** priceA (vqA/vtA) <= priceB (vqB/vtB) * multBps / 10000, in integer math. */
function atMostMult(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint, multBps: number): boolean {
  return vqA * vtB * BPS <= vqB * vtA * BigInt(multBps);
}

/** priceA >= priceB * (10000 - dropBps) / 10000, i.e. priceA fell at most dropBps below priceB. */
function withinDrop(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint, dropBps: number): boolean {
  return vqA * vtB * BPS >= vqB * vtA * (BPS - BigInt(dropBps));
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const watched = new Map<string, Watched>();
  const managed = new Map<string, Managed>();
  /** Mints whose sells the curve cannot pay out (real reserves drained): retry later. */
  const unsellableUntil = new Map<string, number>();

  function noteTrade(mint: string, slot: number, vq: bigint, vt: bigint, isBuy: boolean, solAmount: bigint): void {
    let w = watched.get(mint);
    if (w === undefined) {
      // First sight is a trade, not a creation: treat this price as the base.
      w = {
        mint,
        createdSlot: slot,
        createVq: vq,
        createVt: vt,
        buyVol: 0n,
        buyTrades: 0,
        decided: false,
        complete: false,
        lastVq: vq,
        lastVt: vt,
      };
      watched.set(mint, w);
    }
    w.lastVq = vq;
    w.lastVt = vt;
    if (isBuy) {
      w.buyVol += solAmount;
      w.buyTrades += 1;
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): (BuyInput | SellInput)[] {
      const p = params;
      const orders: (BuyInput | SellInput)[] = [];
      const { caps } = state.hello;
      const tx = state.txFeeLamports();

      // 0. Learn from fills: a sell the curve could not pay out (its real
      // reserves drained below what the tokens are worth) stays unsellable
      // until buyers return; spamming it every batch only wastes replies.
      for (const f of batch.fills) {
        if (f.status === 'rejected' && f.reason === 'max_order_size' && f.side === 'sell') {
          unsellableUntil.set(f.mint, batch.slot + 2_000);
        }
      }

      // 1. Fold this slot's events into the watch list.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!watched.has(e.mint)) {
            watched.set(e.mint, {
              mint: e.mint,
              createdSlot: e.slot,
              createVq: BigInt(e.virtual_quote_reserves),
              createVt: BigInt(e.virtual_token_reserves),
              buyVol: 0n,
              buyTrades: 0,
              decided: false,
              complete: false,
              lastVq: BigInt(e.virtual_quote_reserves),
              lastVt: BigInt(e.virtual_token_reserves),
            });
          }
        } else if (e.event === 'TradeEvent') {
          noteTrade(
            e.mint,
            e.slot,
            BigInt(e.virtual_quote_reserves),
            BigInt(e.virtual_token_reserves),
            e.is_buy,
            BigInt(e.sol_amount),
          );
        } else {
          const w = watched.get(e.mint);
          if (w !== undefined) w.complete = true;
        }
      }

      // 2. Drop managed positions the account no longer holds (sold or closed).
      for (const mint of [...managed.keys()]) {
        if (!state.positions.has(mint)) managed.delete(mint);
      }
      // 3. Start managing any new position (its cost basis is the entry price).
      for (const [mint, pos] of state.positions) {
        if (!managed.has(mint)) {
          const curve = state.curves.get(mint);
          managed.set(mint, {
            mint,
            entrySlot: batch.slot,
            peakVq: curve !== undefined ? curve.virtual_quote_reserves : 0n,
            peakVt: curve !== undefined ? curve.virtual_token_reserves : 1n,
            tp1Done: false,
            tp2Done: false,
            adds: 0,
          });
        }
        void pos;
      }

      // 4. Exits first: free slots before deciding new entries.
      for (const [mint, pos] of state.positions) {
        const m = managed.get(mint);
        const curve = state.curves.get(mint);
        if (m === undefined || curve === undefined || curve.complete) continue;
        const blockedUntil = unsellableUntil.get(mint);
        if (blockedUntil !== undefined && batch.slot < blockedUntil) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        // Tokens already promised by sells still in flight: never sell them twice.
        // Scale the cost basis to the tokens still free, so the entry price
        // (cost per token) stays right while a partial sell is in flight.
        let promised = 0n;
        for (const p of state.pending.values()) {
          if (p.order.side === 'sell' && p.order.mint === mint) promised += BigInt(p.order.token_amount);
        }
        const held = pos.token_amount;
        const tokens = held - promised;
        const cost = held > 0n ? (pos.cost_lamports * tokens) / held : 0n;
        if (tokens <= 0n || cost <= 0n) continue;

        // Peak since entry, for the trailing stop. Entry price is cost/tokens.
        if (vq * m.peakVt >= m.peakVq * vt) {
          m.peakVq = vq;
          m.peakVt = vt;
        }

        const atTp2 = atLeastMult(vq, vt, cost, tokens, p.takeProfit2Bps);
        const atTp1 = atLeastMult(vq, vt, cost, tokens, p.takeProfit1Bps);
        const hitTrail = !withinDrop(vq, vt, m.peakVq, m.peakVt, p.trailBps);
        const hitStop = !withinDrop(vq, vt, cost, tokens, p.stopBps);
        const flatTooLong =
          batch.slot - m.entrySlot >= p.timeStopSlots &&
          !atLeastMult(vq, vt, cost, tokens, p.timeStopMultBps);

        if (hitTrail || hitStop || flatTooLong) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: p.sellSlippageBps });
          continue;
        }
        if (atTp2 && !m.tp2Done) {
          // Sell half of what is left; the rest rides under the trailing stop.
          const half = tokens / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: p.sellSlippageBps });
          }
          m.tp1Done = true;
          m.tp2Done = true;
          continue;
        }
        if (atTp1 && !m.tp1Done) {
          const half = tokens / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: p.sellSlippageBps });
          }
          m.tp1Done = true;
        }
      }

      // 5. Pyramid adds, then new entries. An add goes only into a position
      // that has already proved itself: the price climbed to a multiple of
      // the blended entry price AND the size cap grew with it, so the add is
      // both earned and affordable. Losers never reach an add, so capital
      // concentrates in the coins that run. Adds never take a new slot.
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();
      for (const [mint, pos] of state.positions) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const m = managed.get(mint);
        const curve = state.curves.get(mint);
        if (m === undefined || curve === undefined || curve.complete) continue;
        const blockedUntil = unsellableUntil.get(mint);
        if (blockedUntil !== undefined && batch.slot < blockedUntil) continue;
        // No add while a sell is in flight on this mint.
        let sellPending = false;
        for (const pd of state.pending.values()) {
          if (pd.order.side === 'sell' && pd.order.mint === mint) {
            sellPending = true;
            break;
          }
        }
        if (sellPending) continue;
        const held = pos.token_amount;
        const cost = pos.cost_lamports;
        if (held <= 0n || cost <= 0n) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const cap = state.maxBuyLamports(mint);
        if (m.adds === 0 && atLeastMult(vq, vt, cost, held, p.add2MultBps) && cap >= p.add2CapLamports) {
          const amount = cap < p.add2StakeLamports ? cap : p.add2StakeLamports;
          if (amount > 0n && free >= amount + tx) {
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            m.adds = 1;
            free -= amount + tx;
          }
        } else if (m.adds === 1 && atLeastMult(vq, vt, cost, held, p.add3MultBps) && cap >= p.add3CapLamports) {
          const amount = cap < p.add3StakeLamports ? cap : p.add3StakeLamports;
          if (amount > 0n && free >= amount + tx) {
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            m.adds = 2;
            free -= amount + tx;
          }
        }
      }

      // 6. New entries: one buy per coin, as soon as its size cap opens while it
      // is still young and has not run away. The cap opening is itself the
      // spark: real buyers have put SOL into the curve.
      for (const w of watched.values()) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (w.decided || w.complete) continue;
        const age = batch.slot - w.createdSlot;
        if (age > p.maxEntryAgeSlots) {
          w.decided = true;
          continue;
        }
        if (w.buyTrades < p.minBuyTrades || w.buyVol < p.minBuyVolLamports) continue;
        if (!atLeastMult(w.lastVq, w.lastVt, w.createVq, w.createVt, p.entryMultBps)) continue;
        if (!atMostMult(w.lastVq, w.lastVt, w.createVq, w.createVt, p.maxEntryMultBps)) continue;
        const cap = state.maxBuyLamports(w.mint);
        if (cap < p.minBuyLamports) continue;
        if (slots <= 0) {
          w.decided = true;
          continue;
        }
        const amount = cap < p.stakeLamports ? cap : p.stakeLamports;
        if (free < amount + tx) {
          w.decided = true;
          continue;
        }
        orders.push({ side: 'buy', mint: w.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        w.decided = true;
        free -= amount + tx;
        slots -= 1;
      }

      // 7. Sweep out stale watched coins so the map stays small.
      if (watched.size > 4000) {
        for (const [mint, w] of watched) {
          if (w.decided || batch.slot - w.createdSlot > p.maxEntryAgeSlots) watched.delete(mint);
        }
      }
      return orders;
    },
  };
}
