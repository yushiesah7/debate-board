// @ts-check
/**
 * Human adapter. Unlike the other adapters, this one is a factory: the
 * server/GUI layer owns a `bridge` that resolves a pending human turn (via
 * POST /api/say or a skip button), and this module just adapts that bridge
 * to the common `speak(ctx) -> TurnResult` interface.
 *
 * @typedef {object} HumanBridge
 * @property {(participantId:string, timeoutMs:number) => Promise<{text:string}|{skip:true}>} wait
 */

import { failResult } from "./util.mjs";

/** 5 minutes of inactivity auto-passes the human turn, per spec. */
export const HUMAN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {HumanBridge} bridge
 * @returns {{speak: (ctx: import('../engine.mjs').SpeakCtx) => Promise<import('./util.mjs').TurnResult>}}
 */
export function makeHuman(bridge) {
  return {
    async speak(ctx) {
      try {
        const outcome = await bridge.wait(ctx.participant.id, HUMAN_TIMEOUT_MS);
        if (!outcome || "skip" in outcome) {
          return { utterance: "", cardOps: [], noteUpdate: null, pass: true, error: null };
        }
        return {
          utterance: typeof outcome.text === "string" ? outcome.text : "",
          cardOps: [],
          noteUpdate: null,
          pass: false,
          error: null,
        };
      } catch (err) {
        return failResult(err);
      }
    },
  };
}
