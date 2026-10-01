/**
 * The model, as one import.
 *
 * `src/domain` imports nothing above itself — no React, no DOM, no clock, no
 * randomness — so this barrel is the entire boundary between the engine and
 * everything that draws it. The worker imports from here; so does a Node script
 * that wants to run a scenario without a browser anywhere in sight.
 *
 * Deep imports (`@/domain/load`) stay legal and are what the hot path uses
 * internally; this file exists so a screen never has to know which of eleven
 * modules a helper happens to live in.
 */

// The contract itself.
export * from '@/domain/types'

// Helpers every module leans on.
export * from '@/domain/lookup'

// The pipeline, in run order.
export * from '@/domain/time'
export * from '@/domain/indexes'
export * from '@/domain/capability'
export * from '@/domain/oee'
export * from '@/domain/rates'
export * from '@/domain/capacity'
export * from '@/domain/sourcing'
export * from '@/domain/load'
export * from '@/domain/moves'
export * from '@/domain/rollup'
export * from '@/domain/relief'
export * from '@/domain/engine'
