import { describe, expect, it } from 'vitest';
import { combineScores } from './combine.js';

const v = (
  verdict: 'benign' | 'suspicious' | 'malicious',
  confidence: 'low' | 'medium' | 'high',
  score: number,
) => ({ verdict, confidence, score });

describe('combineScores', () => {
  it('keeps the heuristic score when the model did not run', () => {
    expect(combineScores(0.82, null)).toBe(0.82);
    expect(combineScores(0.82, undefined)).toBe(0.82);
  });

  it('never lets the model lower a confident heuristic finding', () => {
    // The regression this exists to prevent: a model that answers "suspicious / medium" to
    // everything used to overwrite 0.90 with 0.65 and quietly unflag a real attack.
    expect(combineScores(0.9, v('suspicious', 'medium', 0.65))).toBe(0.9);
    expect(combineScores(0.9, v('benign', 'low', 0.15))).toBe(0.9);
    expect(combineScores(0.9, v('benign', 'medium', 0.08))).toBe(0.9);
  });

  it('lets the model escalate', () => {
    expect(combineScores(0.45, v('malicious', 'high', 0.97))).toBe(0.97);
    expect(combineScores(0.65, v('suspicious', 'high', 0.8))).toBe(0.8);
  });

  it('allows deliberate de-escalation only on a confident benign verdict', () => {
    // The partner-sync case: every behavioural signal says scraping, the model recognises a named
    // integration doing the bulk work it is meant to do.
    expect(combineScores(0.88, v('benign', 'high', 0.02))).toBe(0.02);
  });
});
